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
    res.status(500).json({ error: 'Failed to register user' });
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
    sock.ev.on('connection.update', ({ connection, lastDisconnect, pairingCode }) => {
      if (connection === 'open') {
        console.log('WhatsApp Bot Connected');
        io.emit('whatsappStatus', 'connected');
      } else if (connection === 'close') {
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('Reconnecting...');
          io.emit('whatsappStatus', 'disconnected');
          startWhatsAppBot();
        } else {
          console.log('WhatsApp logged out. Needs re-authentication.');
          io.emit('whatsappStatus', 'loggedOut');
        }
      }
      if (pairingCode) {
        console.log(`Pairing Code: ${pairingCode}`);
        io.emit('pairingCode', pairingCode);
      }
    });
    return sock;
  } catch (error) {
    console.error('Error starting WhatsApp bot:', error);
  }
}
startWhatsAppBot().then(sock => whatsappSock = sock).catch(console.error);

// Start Server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
