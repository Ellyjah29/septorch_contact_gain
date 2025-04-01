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

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Rate limiting for security
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Error:', err));

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
    console.error('Error sending daily reminders:', error);
  }
}
setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);

// Admin Login Route
app.post('/api/adminLogin', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(403).json({ success: false, message: 'Invalid password' });
  }
});

// Serve Admin Panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin API Routes
app.get('/api/getUsers', adminAuth, async (req, res) => {
  try {
    const users = await Contact.find();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/removeUser', adminAuth, async (req, res) => {
  try {
    await Contact.deleteOne({ phone: req.body.phone });
    res.json({ message: 'User removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// WhatsApp Pair Code Authentication
let whatsappSock;
async function startWhatsAppBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      getMessage: async () => ({ conversation: '' }),
    });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('Reconnecting...');
          startWhatsAppBot();
        } else {
          console.log('Logged out. Restart required.');
        }
      }
    });
    
    whatsappSock = sock;
    console.log('WhatsApp Bot Connected');
  } catch (error) {
    console.error('WhatsApp Bot Error:', error);
  }
}
startWhatsAppBot();

// Generate Pair Code
app.get('/api/generatePairCode', adminAuth, async (req, res) => {
  if (!whatsappSock) return res.status(500).json({ error: 'WhatsApp is not connected' });
  try {
    const pairCode = await whatsappSock.requestPairingCode(process.env.ADMIN_PHONE);
    res.json({ pairCode });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate pair code' });
  }
});

// Notify Admin of WhatsApp Logout
io.on('connection', (socket) => {
  console.log('Admin connected');
  socket.on('requestStatus', () => {
    socket.emit('whatsappStatus', whatsappSock ? 'connected' : 'disconnected');
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
