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
const QRCode = require('qrcode'); // For QR code generation
const Pino = require('pino'); // For better logging

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
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload()); // Middleware for file uploads

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => logger.info('MongoDB Connected'))
  .catch(err => logger.error('MongoDB Error:', err));

// Contacts Schema
const ContactSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  joinedChannel: { type: Boolean, default: false },
  optedOut: { type: Boolean, default: false }
});
const Contact = mongoose.model('Contact', ContactSchema, 'contacts');

// Admin Authentication Middleware
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }
  if (token !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid admin password' });
  }
  next();
}

// Email Setup
const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
});

// Send Daily Email Reminders
async function sendDailyReminder() {
  try {
    const users = await Contact.find({ joinedChannel: false, optedOut: false });
    users.forEach(user => {
      transporter.sendMail({
        from: process.env.EMAIL,
        to: user.email,
        subject: 'Join Our WhatsApp Channel',
        html: `<p>Hello ${user.name},<br>Join our WhatsApp channel: <a href="${process.env.WHATSAPP_CHANNEL}">Click here</a></p>`
      });
    });
  } catch (error) {
    logger.error('Error sending daily reminders:', error);
  }
}
setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);

// Registration Endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone || !email) return res.status(400).json({ error: 'All fields are required' });

    let user = await Contact.findOne({ phone });
    if (!user) {
      user = new Contact({ name, phone, email });
      await user.save();
      const vcfEntry = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL:${phone}\nEMAIL:${email}\nEND:VCARD\n`;
      fs.appendFileSync('contacts.vcf', vcfEntry);
    }
    res.json({ message: 'Registered successfully' });
  } catch (error) {
    logger.error('Registration Error:', error);
    res.status(500).json({ error: 'Failed to register user' });
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
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.name = newName;
    user.phone = newPhone;
    await user.save();
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    logger.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Admin Login API
app.post('/api/adminLogin', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ message: 'Login successful' });
});

// Upload Custom VCF File
app.post('/api/uploadVCF', adminAuth, (req, res) => {
  const vcfFile = req.files.vcfFile;
  const uploadPath = path.join(__dirname, 'uploads', 'custom-vcf.vcf');
  vcfFile.mv(uploadPath, (err) => {
    if (err) {
      logger.error('Error uploading VCF file:', err);
      return res.status(500).send(err);
    }
    res.json({ message: 'VCF file uploaded successfully' });
  });
});

// Export User Data as CSV
app.get('/api/exportUsers', adminAuth, async (req, res) => {
  try {
    const users = await Contact.find();
    const csvWriter = createObjectCsvWriter({
      path: 'users.csv',
      header: [
        { id: 'name', title: 'Name' },
        { id: 'phone', title: 'Phone' },
        { id: 'email', title: 'Email' },
        { id: 'joinedChannel', title: 'Joined Channel' },
      ]
    });

    await csvWriter.writeRecords(users);
    res.download('users.csv');
  } catch (error) {
    logger.error('Error exporting users:', error);
    res.status(500).json({ error: 'Failed to export users' });
  }
});

// Schedule WhatsApp Announcement
app.post('/api/scheduleAnnouncement', adminAuth, async (req, res) => {
  const { message, dateTime } = req.body;
  // Add logic to schedule WhatsApp announcement at specified dateTime
  res.json({ message: 'Announcement scheduled successfully' });
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  if (whatsappSock && whatsappSock.authState) {
    res.status(200).json({ status: 'Bot is running' });
  } else {
    res.status(500).json({ status: 'Bot is not connected' });
  }
});

// WhatsApp Pair Code Authentication
let whatsappSock;
async function startWhatsAppBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info', logger);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          logger.warn('Connection closed due to error, reconnecting...');
          startWhatsAppBot();
        } else {
          logger.warn('Disconnected permanently.');
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp Bot Connected');
        io.emit('whatsappStatus', 'connected');
      } else if (qr) {
        QRCode.toDataURL(qr, (err, url) => {
          if (err) {
            logger.error('Error generating QR code:', err);
            return;
          }
          io.emit('whatsappQR', url); // Emit the QR code as a base64 image URL
        });
      }
    });

    whatsappSock = sock;
  } catch (error) {
    logger.error('Error starting WhatsApp bot:', error);
  }
}

startWhatsAppBot();

// WebSocket Connection
io.on('connection', socket => {
  logger.info('A user connected');
  socket.on('disconnect', () => {
    logger.info('User disconnected');
  });
});

// Server Start
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
