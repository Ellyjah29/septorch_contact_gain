require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketio = require('socket.io');
const fileUpload = require('express-fileupload');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Logger
const Pino = require('pino');
const logger = Pino({ level: 'debug', base: null });

// Rate Limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
});
app.use(limiter);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    logger.info('Connected to MongoDB');
}).catch((err) => {
    logger.error('MongoDB Connection Error:', err);
    process.exit(1);
});

// Contact Schema
const ContactSchema = new mongoose.Schema({
    name: String,
    phone: { type: String, unique: true },
    email: String,
    joinedChannel: { type: Boolean, default: false },
    optedOut: { type: Boolean, default: false },
});
const Contact = mongoose.model('Contact', ContactSchema);

// Admin Password
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Admin Auth Middleware
function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Missing authentication token' });
    if (token !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });
    next();
}

// Email Setup
const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASS,
    },
});

// Daily Email Reminder at 2PM WAT
cron.schedule('0 14 * * *', async () => {
    try {
        const users = await Contact.find();
        for (const user of users) {
            const vcfEntry = `BEGIN:VCARD\nVERSION:3.0\nFN:${user.name}\nTEL;TYPE=CELL:${user.phone}\nEMAIL:${user.email}\nEND:VCARD\n`;
            fs.appendFileSync('contacts.vcf', vcfEntry);
        }
        logger.info('Daily VCF generated.');
    } catch (error) {
        logger.error('Error during daily task:', error);
    }
});

// WebSocket
io.on('connection', socket => {
    logger.info('WebSocket user connected');
    socket.on('disconnect', () => logger.info('WebSocket user disconnected'));
});

// Register API
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone } = req.body;
        if (!name || !email || !phone) return res.status(400).json({ error: 'All fields required' });

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const phoneRegex = /^\+?[1-9]\d{9,}$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });
        if (!phoneRegex.test(phone)) return res.status(400).json({ error: 'Invalid phone' });

        const exists = await Contact.findOne({ phone });
        if (exists) return res.status(409).json({ error: 'Phone already registered' });

        const newUser = new Contact({ name, email, phone });
        await newUser.save();

        const vcfEntry = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;TYPE=CELL:${phone}\nEMAIL:${email}\nEND:VCARD\n`;
        fs.appendFileSync('contacts.vcf', vcfEntry);

        res.json({ message: 'Registered successfully' });
    } catch (error) {
        logger.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Check Contacts API
app.get('/api/checkContacts', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Phone required' });

        const phoneRegex = /^\+?[1-9]\d{9,}$/;
        if (!phoneRegex.test(phone)) return res.status(400).json({ error: 'Invalid phone' });

        const user = await Contact.findOne({ phone });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const contacts = await Contact.find({ _id: { $ne: user._id } }, 'name phone email joinedChannel optedOut');
        const totalContacts = await Contact.countDocuments({ _id: { $ne: user._id } });

        res.json({ contacts, totalContacts });
    } catch (error) {
        logger.error('Check contacts error:', error);
        res.status(500).json({ error: 'Check failed' });
    }
});

// Admin Panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin API
app.get('/api/getUsers', adminAuth, async (req, res) => {
    try {
        const users = await Contact.find();
        res.json(users);
    } catch (error) {
        logger.error('Get users error:', error);
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.post('/api/removeUser', adminAuth, async (req, res) => {
    try {
        await Contact.deleteOne({ phone: req.body.phone });
        res.json({ message: 'User removed' });
    } catch (error) {
        logger.error('Remove user error:', error);
        res.status(500).json({ error: 'Remove failed' });
    }
});

app.post('/api/editUser', adminAuth, async (req, res) => {
    try {
        const { oldPhone, newName, newPhone } = req.body;
        const user = await Contact.findOne({ phone: oldPhone });
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.name = newName;
        user.phone = newPhone;
        await user.save();

        res.json({ message: 'User updated' });
    } catch (error) {
        logger.error('Edit user error:', error);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/adminLogin', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    res.json({ message: 'Login successful' });
});

// Upload VCF
app.post('/api/uploadVCF', adminAuth, (req, res) => {
    const vcfFile = req.files?.vcfFile;
    if (!vcfFile) return res.status(400).json({ error: 'No file uploaded' });

    const uploadPath = path.join(__dirname, 'uploads', 'custom-vcf.vcf');
    vcfFile.mv(uploadPath, (err) => {
        if (err) {
            logger.error('VCF upload error:', err);
            return res.status(500).json({ error: 'Upload failed' });
        }
        res.json({ message: 'VCF uploaded' });
    });
});

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'Server is running' });
});

// Start Server
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});
