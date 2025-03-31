require('dotenv').config(); const express = require('express'); const mongoose = require('mongoose'); const nodemailer = require('nodemailer'); const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys'); const fs = require('fs'); const path = require('path'); const rateLimit = require('express-rate-limit'); const multer = require('multer'); const csvStringify = require('csv-stringify'); const schedule = require('node-schedule'); const http = require('http'); const socketio = require('socket.io');

const app = express(); const server = http.createServer(app); const io = socketio(server); const PORT = process.env.PORT || 3000;

// Rate limiting const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 }); app.use(limiter); app.use(express.json()); app.use(express.static('public'));

// MongoDB Connection mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true }) .then(() => console.log('MongoDB Connected')) .catch(err => console.error('MongoDB Connection Error:', err));

// User Schema const UserSchema = new mongoose.Schema({ whatsappNumber: String, email: String, referrals: { type: Number, default: 0 }, joinedChannel: { type: Boolean, default: false }, optedOut: { type: Boolean, default: false }, ip: String, }); const User = mongoose.model('User', UserSchema);

// Admin authentication const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; function adminAuth(req, res, next) { const token = req.headers['x-admin-token']; if (token && token === ADMIN_PASSWORD) { next(); } else { res.status(401).send('Unauthorized'); } }

// Nodemailer setup const transporter = nodemailer.createTransport({ service: 'Gmail', auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS }, });

// Daily Reminder async function sendDailyReminder() { const users = await User.find({ joinedChannel: false, optedOut: false }); users.forEach(user => { transporter.sendMail({ from: process.env.EMAIL, to: user.email, subject: 'Join Our WhatsApp Channel', html: <p>Join our WhatsApp channel to continue receiving the VCF file. <a href="${process.env.WHATSAPP_CHANNEL}">Click here</a></p> <p><a href="http://localhost:${PORT}/joined/${user.whatsappNumber}">I Joined</a> |  <a href="http://localhost:${PORT}/optout/${user.whatsappNumber}">Not Interested</a></p> }); }); }

// Handle User Actions app.get('/joined/:whatsappNumber', async (req, res) => { await User.updateOne({ whatsappNumber: req.params.whatsappNumber }, { joinedChannel: true }); res.send('You will no longer receive reminders.'); }); app.get('/optout/:whatsappNumber', async (req, res) => { await User.deleteOne({ whatsappNumber: req.params.whatsappNumber }); res.send('You have been removed from the database.'); });

// Register User app.post('/register', async (req, res) => { const { whatsappNumber, email } = req.body; let user = await User.findOne({ whatsappNumber }); if (!user) { user = new User({ whatsappNumber, email, ip: req.ip }); await user.save(); io.emit('newUser', user); } res.json({ message: 'User registered', referralLink: /referral/${whatsappNumber} }); });

// Admin: Export CSV app.get('/admin/export', adminAuth, async (req, res) => { const users = await User.find(); const csvData = [['WhatsApp Number', 'Email', 'Referrals', 'Joined Channel', 'IP']]; users.forEach(user => csvData.push([user.whatsappNumber, user.email || '', user.referrals, user.joinedChannel, user.ip || ''])); res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="users.csv"'); csvStringify(csvData, (err, output) => res.send(err ? 'Error generating CSV' : output)); });

// WhatsApp Bot Setup (Pair Code Authentication) let whatsappSock; async function startWhatsAppBot() { const { state, saveCreds } = await useMultiFileAuthState('auth_info'); const { version } = await fetchLatestBaileysVersion(); whatsappSock = makeWASocket({ auth: state, version, printQRInTerminal: false }); whatsappSock.ev.on('creds.update', saveCreds);

whatsappSock.ev.on('connection.update', ({ connection, lastDisconnect }) => { if (connection === 'open') { console.log('WhatsApp Bot Connected'); io.emit('whatsappStatus', 'Connected'); } else if (connection === 'close') { console.log('WhatsApp Disconnected, reconnecting...'); io.emit('whatsappStatus', 'Disconnected'); startWhatsAppBot(); } }); } startWhatsAppBot();

// Admin Panel Real-time WhatsApp Status io.on('connection', (socket) => { console.log('Admin connected'); socket.emit('whatsappStatus', whatsappSock ? 'Connected' : 'Disconnected'); });

// Server Start server.listen(PORT, () => console.log(Server running on port ${PORT}));

// Schedule Daily Tasks setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);

