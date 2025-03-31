require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const csvStringify = require('csv-stringify');
const schedule = require('node-schedule');
const http = require('http');
const socketio = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Apply rate limiting middleware to all requests
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute per IP
});
app.use(limiter);

// Middleware for parsing JSON and serving static files
app.use(express.json());
app.use(express.static('public'));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// Define User Schema (with IP tracking)
const UserSchema = new mongoose.Schema({
  whatsappNumber: String,
  email: String,
  referrals: { type: Number, default: 0 },
  joinedChannel: { type: Boolean, default: false },
  optedOut: { type: Boolean, default: false },
  ip: String,
});
const User = mongoose.model('User', UserSchema);

// Admin authentication middleware (uses ADMIN_PASSWORD from .env)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && token === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).send('Unauthorized');
  }
}

// Configure Nodemailer for email reminders
const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
});

// Daily Email Reminder function
async function sendDailyReminder() {
  const users = await User.find({ joinedChannel: false, optedOut: false });
  users.forEach(user => {
    transporter.sendMail({
      from: process.env.EMAIL,
      to: user.email, // Users must register with their valid email
      subject: 'Join Our WhatsApp Channel',
      html: `<p>Join our WhatsApp channel to continue receiving the VCF file. <a href="${process.env.WHATSAPP_CHANNEL}">Click here</a></p>
             <p><a href="http://localhost:${PORT}/joined/${user.whatsappNumber}">I Joined</a> | 
             <a href="http://localhost:${PORT}/optout/${user.whatsappNumber}">Not Interested</a></p>`,
    });
  });
}

// Endpoint: Mark user as joined (stop reminders)
app.get('/joined/:whatsappNumber', async (req, res) => {
  await User.updateOne({ whatsappNumber: req.params.whatsappNumber }, { joinedChannel: true });
  res.send('You will no longer receive reminders.');
});

// Endpoint: Opt out (delete user)
app.get('/optout/:whatsappNumber', async (req, res) => {
  await User.deleteOne({ whatsappNumber: req.params.whatsappNumber });
  res.send('You have been removed from the database.');
});

// User Registration Endpoint (with IP tracking)
app.post('/register', async (req, res) => {
  const { whatsappNumber, email } = req.body;
  const ip = req.ip;
  let user = await User.findOne({ whatsappNumber });
  if (!user) {
    user = new User({ whatsappNumber, email, ip });
    await user.save();
    io.emit('newUser', user); // Real-time update via Socket.io
  }
  res.json({ message: 'User registered', referralLink: `/referral/${whatsappNumber}` });
});

// Referral Endpoint
app.get('/referral/:whatsappNumber', async (req, res) => {
  const { whatsappNumber } = req.params;
  const ip = req.ip;
  const referrer = await User.findOne({ whatsappNumber });
  if (referrer) {
    // Optionally, validate IP to prevent fake referrals
    referrer.referrals += 1;
    await referrer.save();
    io.emit('updateReferral', { whatsappNumber, referrals: referrer.referrals });
  }
  res.send('Referral recorded!');
});

// Admin Endpoint: Export User Data as CSV
app.get('/admin/export', adminAuth, async (req, res) => {
  const users = await User.find();
  const csvData = [];
  csvData.push(['WhatsApp Number', 'Email', 'Referrals', 'Joined Channel', 'IP']);
  users.forEach(user => {
    csvData.push([user.whatsappNumber, user.email || '', user.referrals, user.joinedChannel, user.ip || '']);
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  csvStringify(csvData, (err, output) => {
    if (err) res.status(500).send('Error generating CSV');
    else res.send(output);
  });
});

// Configure multer for VCF file upload (customization by admin)
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, '.');
  },
  filename: function(req, file, cb) {
    cb(null, 'contacts.vcf');
  }
});
const upload = multer({ storage });
app.post('/admin/upload-vcf', adminAuth, upload.single('vcfFile'), (req, res) => {
  res.send('VCF file uploaded successfully.');
});

// Admin Endpoint: Schedule an announcement message (using node-schedule)
let scheduledJob;
app.post('/admin/schedule-message', adminAuth, (req, res) => {
  const { message, cron } = req.body; // Cron format, e.g., '0 9 * * *' for 9 AM daily
  if (scheduledJob) scheduledJob.cancel();
  scheduledJob = schedule.scheduleJob(cron, async () => {
    if (whatsappSock) {
      await whatsappSock.sendMessage(process.env.WHATSAPP_CHANNEL, { text: message });
      console.log('Scheduled message sent');
    }
  });
  res.send('Message scheduled successfully');
});

// Admin Endpoint: Cancel scheduled message
app.post('/admin/cancel-schedule', adminAuth, (req, res) => {
  if (scheduledJob) {
    scheduledJob.cancel();
    scheduledJob = null;
    res.send('Scheduled message cancelled');
  } else {
    res.send('No scheduled message to cancel');
  }
});

// Real-time updates using Socket.io for referral leaderboard, etc.
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Function to send VCF file to WhatsApp Channel using Baileys
async function sendVCFToChannel(sock) {
  const channelJid = process.env.WHATSAPP_CHANNEL_JID;
  const vcfPath = path.join(__dirname, 'contacts.vcf');
  if (fs.existsSync(vcfPath)) {
    const vcfBuffer = fs.readFileSync(vcfPath);
    await sock.sendMessage(channelJid, { document: vcfBuffer, mimetype: 'text/x-vcard', fileName: 'contacts.vcf' });
    console.log('VCF file sent to WhatsApp Channel');
  } else {
    console.log('VCF file not found');
  }
}

// Initialize Baileys WhatsApp Bot
let whatsappSock;
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection } = update;
    if (connection === 'open') {
      console.log('WhatsApp Bot Connected');
    } else if (connection === 'close') {
      console.log('WhatsApp Bot Disconnected, reconnecting...');
      startWhatsAppBot();
    }
  });
  return sock;
}
startWhatsAppBot()
  .then(sock => {
    whatsappSock = sock;
    // Schedule sending VCF file daily
    setInterval(() => { sendVCFToChannel(whatsappSock); }, 24 * 60 * 60 * 1000);
  })
  .catch(err => console.error('WhatsApp Bot Error:', err));

// Start the HTTP server with Socket.io
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Schedule daily email reminders
setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);
