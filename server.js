// Load required modules
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { default: Baileys } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketio = require('socket.io');
const axios = require('axios');
const FormData = require('form-data');
const cheerio = require('cheerio');
const QRCode = require('qrcode'); // For QR code generation
const Pino = require('pino'); // For better logging

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Logger Setup
const logger = Pino({ level: 'debug', base: null });

// Rate Limiting for Security
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve static files from the "public" folder

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
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  if (token !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });
  next();
}

// Start WhatsApp Bot
let whatsappSock;
async function startWhatsAppBot() {
  try {
    const { state, saveCreds } = await Baileys.useMultiFileAuthState('./session');
    const { version } = await Baileys.fetchLatestBaileysVersion();

    const sock = Baileys.makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      getMessage: async () => ({ conversation: '' }),
      browser: 'GiftedBot',
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect.error instanceof Baileys.DisconnectReason) && lastDisconnect.error.output.statusCode !== Baileys.DisconnectReason.loggedOut;
        if (shouldReconnect) {
          logger.warn('Connection closed due to error, reconnecting...');
          startWhatsAppBot();
        } else {
          logger.warn('Disconnected permanently.');
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp Bot Connected');
        // Send a success message to the bot's own number
        const botNumber = sock.user.id.split(':')[0];
        await sock.sendMessage(`${botNumber}@c.us`, { text: 'WhatsApp bot has successfully connected!' });
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

// Function to check if a phone number is registered on WhatsApp
async function isRegisteredOnWhatsApp(phone) {
  if (!whatsappSock) {
    throw new Error('WhatsApp bot is not connected.');
  }

  const formattedPhone = `${phone}@c.us`; // Format the phone number correctly
  try {
    const status = await whatsappSock.query({ json: ['status', formattedPhone] });
    return status[1].status === 'available'; // Check if the status is "available"
  } catch (error) {
    logger.error(`Error checking WhatsApp registration for ${phone}:`, error);
    return false; // Assume the number is not registered if an error occurs
  }
}

// Registration Endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if the phone number is already in the database
    let user = await Contact.findOne({ phone });
    if (user) {
      return res.status(409).json({ error: 'User already registered' });
    }

    // Check if the phone number is registered on WhatsApp
    const isRegistered = await isRegisteredOnWhatsApp(phone);
    if (!isRegistered) {
      return res.status(400).json({ error: 'Phone number is not registered on WhatsApp' });
    }

    // Add the user to the database
    user = new Contact({ name, phone, email });
    await user.save();

    // Append the new contact to the .vcf file
    const vcfEntry = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL:${phone}\nEMAIL:${email}\nEND:VCARD\n`;
    fs.appendFileSync('contacts.vcf', vcfEntry);

    // Send the updated .vcf file to the WhatsApp channel
    await sendVCFtoWhatsAppChannel();

    res.json({ message: 'Registered successfully' });
  } catch (error) {
    logger.error('Registration Error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Function to send the .vcf file to the WhatsApp channel
async function sendVCFtoWhatsAppChannel() {
  try {
    const channelJID = process.env.WHATSAPP_CHANNEL_JID; // WhatsApp channel JID from .env
    if (!channelJID) {
      logger.error('WhatsApp channel JID not set in .env');
      return;
    }

    const vcfFilePath = path.join(__dirname, 'contacts.vcf');
    if (!fs.existsSync(vcfFilePath)) {
      logger.error('VCF file not found');
      return;
    }

    // Send the .vcard file to the WhatsApp channel
    await whatsappSock.sendMessage(channelJID, {
      document: fs.readFileSync(vcfFilePath), // Read the file as binary
      fileName: 'contacts.vcf', // Name of the file
      mimetype: 'text/vcard', // MIME type for .vcf files
    });

    logger.info('VCF file sent to WhatsApp channel successfully.');
  } catch (error) {
    logger.error('Error sending VCF file to WhatsApp channel:', error);
  }
}

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

// Health Check Endpoint
app.get('/health', (req, res) => {
  if (whatsappSock && whatsappSock.authState) {
    res.status(200).json({ status: 'Bot is running' });
  } else {
    res.status(500).json({ status: 'Bot is not connected' });
  }
});

// WebSocket Connection
io.on('connection', socket => {
  logger.info('A user connected');
  socket.on('disconnect', () => {
    logger.info('User disconnected');
  });
});

// Start the server
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
