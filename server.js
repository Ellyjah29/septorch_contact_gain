require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

// Contacts Schema (Using existing contacts collection)
const ContactSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  referrals: { type: Number, default: 0 },
  joinedChannel: { type: Boolean, default: false },
  optedOut: { type: Boolean, default: false }
});
const Contact = mongoose.model('Contact', ContactSchema, 'contacts');

// Admin Authentication Middleware
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === ADMIN_PASSWORD) next();
  else res.status(401).send('Unauthorized');
}

// Email Setup
const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
});

// Send Daily Email Reminders
async function sendDailyReminder() {
  const users = await Contact.find({ joinedChannel: false, optedOut: false });
  users.forEach(user => {
    transporter.sendMail({
      from: process.env.EMAIL,
      to: user.email,
      subject: 'Join Our WhatsApp Channel',
      html: `<p>Hello ${user.name},<br>Join our WhatsApp channel: <a href="${process.env.WHATSAPP_CHANNEL}">Click here</a></p>`
    });
  });
}
setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);

// Serve Admin Panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get users from contacts collection
app.get('/api/getUsers', adminAuth, async (req, res) => {
  try {
    const users = await Contact.find();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Remove user from contacts collection
app.post('/api/removeUser', adminAuth, async (req, res) => {
  try {
    await Contact.deleteOne({ phone: req.body.phone });
    res.json({ message: 'User removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// Edit user details
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
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// WhatsApp Pair Code Authentication
let whatsappSock;
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    getMessage: async () => ({ conversation: '' }),
  });
  
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, pairingCode }) => {
    if (connection === 'open') {
      console.log('WhatsApp Bot Connected');
      io.emit('whatsappStatus', 'connected');
    } else if (connection === 'close') {
      console.log('WhatsApp Bot Disconnected, reconnecting...');
      io.emit('whatsappStatus', 'disconnected');
      startWhatsAppBot();
    }
    if (pairingCode) {
      console.log(`Pairing Code: ${pairingCode}`);
      io.emit('pairingCode', pairingCode);
    }
  });
  return sock;
}
startWhatsAppBot().then(sock => whatsappSock = sock).catch(console.error);

// Start Server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
