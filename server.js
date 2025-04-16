require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketio = require('socket.io');
const fileUpload = require('express-fileupload');
const { createObjectCsvWriter } = require('csv-writer');

// QR Code Generation and Logging
const QRCode = require('qrcode');
const Pino = require('pino');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Logger Setup
const logger = Pino({
    level: 'debug',
    base: null,
});

// Rate Limiting for Security
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 requests per windowMs
});
app.use(limiter);

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files from the "public" folder
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

// Middleware for Admin Authentication
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

// Send Daily Email Reminders at 2:00 PM WAT (West Africa Time)
cron.schedule('0 14 * * *', async () => {
    try {
        const users = await Contact.find({ optedOut: false });
        for (const user of users) {
            const vcfEntry = `BEGIN:VCARD\nVERSION:3.0\nFN:${user.name}\nTEL;TYPE=CELL:${user.phone}\nEMAIL:${user.email}\nEND:VCARD`;
            fs.appendFileSync('contacts.vcf', vcfEntry);
            await sendVCFtoWhatsAppChannel();
        }
        logger.info('Daily VCF emails sent successfully.');
    } catch (error) {
        logger.error('Error sending daily emails:', error);
    }
});

// WhatsApp Bot Initialization
let whatsappSock;
async function startWhatsAppBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info', logger);
        const { version } = await fetchLatestBaileysVersion();
        whatsappSock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false,
            getMessage: async () => ({ conversation: '' }),
        });

        whatsappSock.ev.on('creds.update', saveCreds);

        // Handle connection updates
        whatsappSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    logger.warn('Connection closed. Reconnecting...');
                    startWhatsAppBot();
                } else {
                    logger.error('Connection closed permanently. Restart required.');
                }
            } else if (connection === 'open') {
                logger.info('WhatsApp bot connected successfully.');
            } else if (qr) {
                logger.info('QR Code generated. Scan it to log in.');
                QRCode.toDataURL(qr, (err, url) => {
                    if (err) logger.error('QR Code generation error:', err);
                    io.emit('qrCode', url);
                });
            }
        });

        // Handle incoming messages
        whatsappSock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (msg.key.remoteJid.endsWith('@s.whatsapp.net')) {
                logger.info(`Message received from ${msg.key.remoteJid}: ${msg.message.conversation}`);
            }
        });
    } catch (error) {
        logger.error('Error starting WhatsApp bot:', error);
    }
}
startWhatsAppBot();

// WebSocket Communication
io.on('connection', socket => {
    logger.info('A user connected via WebSocket');
    socket.on('disconnect', () => {
        logger.info('User disconnected from WebSocket');
    });
});

// Register User API
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone } = req.body;

        // Validate input
        if (!name || !email || !phone) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const phoneRegex = /^\+?[1-9]\d{9,}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }

        // Check if the user already exists
        const existingUser = await Contact.findOne({ phone });
        if (existingUser) {
            return res.status(409).json({ error: 'Phone number already registered' });
        }

        // Save the new user
        const newUser = new Contact({ name, email, phone });
        await newUser.save();

        // Append VCF entry
        const vcfEntry = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;TYPE=CELL:${phone}\nEMAIL:${email}\nEND:VCARD`;
        fs.appendFileSync('contacts.vcf', vcfEntry);

        // Send VCF to WhatsApp channel
        await sendVCFtoWhatsAppChannel();

        res.json({ message: 'Registered successfully' });
    } catch (error) {
        logger.error('Registration Error:', error);
        res.status(500).json({ error: 'Failed to register user' });
    }
});

// Check Contacts API - Fetch All Contacts
app.get('/api/checkContacts', async (req, res) => {
    try {
        const { phone } = req.query;

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // Validate phone number format
        const phoneRegex = /^\+?[1-9]\d{9,}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }

        // Find the user by phone number
        const user = await Contact.findOne({ phone });
        if (!user) {
            return res.status(404).json({ error: 'User not found in the database' });
        }

        // Fetch all contacts excluding the current user and opted-out users
        const contacts = await Contact.find(
            { _id: { $ne: user._id }, optedOut: false }, // Exclude the current user and opted-out users
            'name phone' // Only select name and phone fields
        );

        // Get total number of valid contacts
        const totalContacts = await Contact.countDocuments({ _id: { $ne: user._id }, optedOut: false });

        res.json({ contacts, totalContacts });
    } catch (error) {
        logger.error('Error checking contacts:', error);
        res.status(500).json({ error: 'Failed to check contacts' });
    }
});

// Admin Panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin API Routes
app.get('/api/getUsers', adminAuth, async (req, res) => {
    try {
        const users = await Contact.find();
        res.json(users);
    } catch (error) {
        logger.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.post('/api/removeUser', adminAuth, async (req, res) => {
    try {
        await Contact.deleteOne({ phone: req.body.phone });
        res.json({ message: 'User removed' });
    } catch (error) {
        logger.error('Error removing user:', error);
        res.status(500).json({ error: 'Failed to remove user' });
    }
});

app.post('/api/editUser', adminAuth, async (req, res) => {
    try {
        const { oldPhone, newName, newPhone } = req.body;

        const user = await Contact.findOne({ phone: oldPhone });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.name = newName;
        user.phone = newPhone;
        await user.save();

        res.json({ message: 'User updated successfully' });
    } catch (error) {
        logger.error('Error updating user:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

app.post('/api/adminLogin', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    res.json({ message: 'Login successful' });
});

// Upload Custom VCF File
app.post('/api/uploadVCF', adminAuth, (req, res) => {
    const vcfFile = req.files?.vcfFile;
    if (!vcfFile) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const uploadPath = path.join(__dirname, 'uploads', 'custom-vcf.vcf');
    vcfFile.mv(uploadPath, (err) => {
        if (err) {
            logger.error('Error uploading VCF file:', err);
            return res.status(500).json({ error: 'Failed to upload VCF file' });
        }
        res.json({ message: 'VCF file uploaded successfully' });
    });
});

// Schedule Announcement
app.post('/api/scheduleAnnouncement', adminAuth, async (req, res) => {
    const { message, dateTime } = req.body;
    if (!message || !dateTime) {
        return res.status(400).json({ error: 'Message and date/time are required' });
    }

    try {
        const scheduledTime = new Date(dateTime);
        if (scheduledTime < new Date()) {
            return res.status(400).json({ error: 'Scheduled time must be in the future' });
        }

        setTimeout(async () => {
            if (whatsappSock && whatsappSock.user) {
                const botNumber = whatsappSock.user.id.split(':')[0];
                await whatsappSock.sendMessage(botNumber, { text: message });
            }
        }, scheduledTime - new Date());

        res.json({ message: 'Announcement scheduled successfully' });
    } catch (error) {
        logger.error('Error scheduling announcement:', error);
        res.status(500).json({ error: 'Failed to schedule announcement' });
    }
});

// Health Check Endpoint
app.get('/health', (req, res) => {
    if (whatsappSock && whatsappSock.authState) {
        res.status(200).json({ status: 'Bot is running' });
    } else {
        res.status(500).json({ status: 'Bot is not connected' });
    }
});

// Start Server
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});
