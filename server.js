require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const schedule = require('node-schedule');
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

// User Schema
const UserSchema = new mongoose.Schema({
  whatsappNumber: String,
  email: String,
  referrals: { type: Number, default: 0 },
  joinedChannel: { type: Boolean, default: false },
  optedOut: { type: Boolean, default: false },
});
const User = mongoose.model('User', UserSchema);

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
  const users = await User.find({ joinedChannel: false, optedOut: false });
  users.forEach(user => {
    transporter.sendMail({
      from: process.env.EMAIL,
      to: user.email,
      subject: 'Join Our WhatsApp Channel',
      html: `<p>Join our WhatsApp channel: <a href="${process.env.WHATSAPP_CHANNEL}">Click here</a></p>`
    });
  });
}
setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);

// User Registration
app.post('/register', async (req, res) => {
  const { whatsappNumber, email } = req.body;
  let user = await User.findOne({ whatsappNumber });
  if (!user) {
    user = new User({ whatsappNumber, email });
    await user.save();
    io.emit('newUser', user);
  }
  res.json({ message: 'User registered', referralLink: `/referral/${whatsappNumber}` });
});

// Referral Tracking
app.get('/referral/:whatsappNumber', async (req, res) => {
  const referrer = await User.findOne({ whatsappNumber: req.params.whatsappNumber });
  if (referrer) {
    referrer.referrals += 1;
    await referrer.save();
    io.emit('updateReferral', { whatsappNumber: referrer.whatsappNumber, referrals: referrer.referrals });
  }
  res.send('Referral recorded!');
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

// Send VCF File to WhatsApp Channel
async function sendVCFToChannel() {
  const vcfPath = path.join(__dirname, 'contacts.vcf');
  if (fs.existsSync(vcfPath) && whatsappSock) {
    const vcfBuffer = fs.readFileSync(vcfPath);
    await whatsappSock.sendMessage(process.env.WHATSAPP_CHANNEL_JID, { document: vcfBuffer, mimetype: 'text/x-vcard', fileName: 'contacts.vcf' });
    console.log('VCF file sent to WhatsApp Channel');
  }
}
setInterval(sendVCFToChannel, 24 * 60 * 60 * 1000);

// Admin Panel: Get WhatsApp Status
app.get('/admin/whatsapp-status', adminAuth, (req, res) => {
  res.json({ status: whatsappSock ? 'connected' : 'disconnected' });
});

// Admin Panel: Get Pairing Code
app.get('/admin/pairing-code', adminAuth, (req, res) => {
  io.once('pairingCode', (code) => {
    res.json({ pairingCode: code });
  });
});

// Real-time Socket.io for Admin Panel
io.on('connection', (socket) => {
  console.log('Admin Panel Connected');
});

// Start Server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
