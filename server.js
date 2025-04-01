require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, WAMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketio = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Error:', err));

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
  if (token === ADMIN_PASSWORD) next();
  else res.status(401).send('Unauthorized');
}

// Email Setup
const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
});

// WhatsApp Bot Initialization
let whatsappSock;
let connected = false; // To keep track of WhatsApp connection status
let botJids = [];

async function startWhatsAppBot(phoneNumber) {
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
    sock.ev.on('connection.update', ({ connection, lastDisconnect, pairingCode, qr }) => {
      if (connection === 'open') {
        connected = true;
        console.log('WhatsApp Bot Connected');
        io.emit('whatsappStatus', 'connected');
        sock.ev.on('group-participants.update', updateBotJids);
      } else if (connection === 'close') {
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('WhatsApp Bot Disconnected, reconnecting...');
          io.emit('whatsappStatus', 'disconnected');
          startWhatsAppBot(phoneNumber);
        } else {
          console.log('WhatsApp logged out. Needs re-authentication.');
          io.emit('whatsappStatus', 'loggedOut');
        }
      }

      if (pairingCode) {
        console.log(`Pairing Code: ${pairingCode}`);
        io.emit('pairingCode', pairingCode);
      }

      if (qr) {
        console.log(`QR Code: ${qr}`);
        io.emit('qrCode', qr); // Emit the QR code for display
      }
    });

    return sock;
  } catch (error) {
    console.error('Error starting WhatsApp bot:', error);
  }
}

// Function to fetch and update JIDs (group IDs) that the bot is part of
async function updateBotJids(update) {
  botJids = update.jids || [];
  io.emit('botJids', botJids);
}

// Endpoint to link WhatsApp
app.post('/api/linkWhatsApp', adminAuth, (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  startWhatsAppBot(phoneNumber).then(sock => {
    whatsappSock = sock;
    res.json({ message: 'WhatsApp bot is now linked' });
  }).catch(err => {
    res.status(500).json({ error: 'Failed to link WhatsApp bot' });
  });
});

// Start Server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
