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
const cron = require('node-cron');
const bcrypt = require('bcrypt'); // For hashing passwords
const Boom = require('@hapi/boom'); // For error handling
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
app.use(express.static('public')); // Serve static files from the "public" folder
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
let hashedAdminPassword;
(async () => {
  hashedAdminPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
})();

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  bcrypt.compare(token, hashedAdminPassword)
    .then(match => match ? next() : res.status(403).json({ error: 'Invalid admin password' }))
    .catch(err => res.status(500).json({ error: 'Authentication failed', details: err.message }));
}

// Email Setup
const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
});

// Send Daily Email Reminders at 2:00 PM WAT (West Africa Time)
cron.schedule('0 14 * * *', async () => {
  try {
    const users = await Contact.find({ joinedChannel: false, optedOut: false });
    for (const user of users) {
      await transporter.sendMail({
        from: process.env.EMAIL,
        to: user.email,
        subject: 'GET YOUR VCF FILE',
        html: `<p>Hello ${user.name},<br> Thanks for joining us! Get your VCF file on our WhatsApp channel: <a href="${process.env.WHATSAPP_CHANNEL}">Click here</a></p>`
      });
    }
    logger.info('Daily reminder emails sent successfully.');
  } catch (error) {
    logger.error('Error sending daily reminders:', error);
  }
}, {
  timezone: 'Africa/Lagos' // Use Nigeria's timezone (WAT)
});

// Function to send the .vcf file to the WhatsApp channel
async function sendVCFtoWhatsAppChannel(sock) {
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
    await sock.sendMessage(channelJID, {
      document: fs.readFileSync(vcfFilePath), // Read the file as binary
      fileName: 'contacts.vcf', // Name of the file
      mimetype: 'text/vcard', // MIME type for .vcf files
    });
    logger.info('VCF file sent to WhatsApp channel successfully.');
  } catch (error) {
    logger.error('Error sending VCF file to WhatsApp channel:', error);
  }
}

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
      await sendVCFtoWhatsAppChannel(whatsappSock);
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
    const { oldPhone, newName, newPhone, newEmail } = req.body;
    const user = await Contact.findOneAndUpdate(
      { phone: oldPhone },
      { name: newName, phone: newPhone, email: newEmail },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    logger.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Admin Login API
app.post('/api/adminLogin', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });
  bcrypt.compare(password, hashedAdminPassword)
    .then(match => match ? res.json({ message: 'Login successful' }) : res.status(401).json({ error: 'Invalid password' }))
    .catch(err => res.status(500).json({ error: 'Authentication failed', details: err.message }));
});

// Upload Custom VCF File
app.post('/api/uploadVCF', adminAuth, (req, res) => {
  const vcfFile = req.files?.vcfFile;
  if (!vcfFile) return res.status(400).json({ error: 'No file uploaded' });
  const uploadPath = path.join(__dirname, 'uploads', 'custom-vcf.vcf');
  vcfFile.mv(uploadPath, (err) => {
    if (err) {
      logger.error('Error uploading VCF file:', err);
      return res.status(500).json({ error: 'Failed to upload VCF file' });
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
  if (!message || !dateTime) return res.status(400).json({ error: 'Message and date/time are required' });
  try {
    const scheduledTime = new Date(dateTime);
    if (scheduledTime < new Date()) return res.status(400).json({ error: 'Scheduled time must be in the future' });

    setTimeout(async () => {
      if (whatsappSock && whatsappSock.user) {
        const botNumber = whatsappSock.user.id.split(':')[0];
        await whatsappSock.sendMessage(botNumber, { text: message });
        logger.info('WhatsApp announcement sent successfully.');
      } else {
        logger.warn('WhatsApp bot is not connected. Announcement skipped.');
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
          logger.warn('Connection closed due to error, reconnecting...');
          startWhatsAppBot();
        } else {
          logger.warn('Disconnected permanently.');
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp Bot Connected');
        const botNumber = whatsappSock.user.id.split(':')[0];
        await whatsappSock.sendMessage(botNumber, { text: 'WhatsApp bot has successfully connected!' });
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

    // Listen for messages
    whatsappSock.ev.on('messages.upsert', m_upsert => {
      const { messages } = m_upsert;
      if (!messages) return;
      const message = messages[0];
      if (message.key.remoteJid === process.env.WHATSAPP_CHANNEL_JID && message.message?.documentMessage) {
        logger.info('New VCF file received in WhatsApp channel.');
      }
    });
  } catch (error) {
    logger.error('Error starting WhatsApp bot:', error);
  }
}
startWhatsAppBot();

// WebSocket Communication
io.on('connection', socket => {
  logger.info('A user connected');
  socket.on('disconnect', () => {
    logger.info('User disconnected');
  });
});

// Start Server
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Trigger Pairing with Phone Number
app.post('/api/startPairing', adminAuth, async (req, res) => {
  try {
    const phone = req.body.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    // Generate a random pairing code
    const pairingCode = Math.random().toString(36).substring(2, 8);
    logger.info(`Pairing initiated for phone ${phone}. Code: ${pairingCode}`);

    // Save the pairing code temporarily (e.g., in memory or database)
    // Here, we simulate saving it in memory
    const pairingData = { phone, code: pairingCode };
    io.emit('pairingCode', pairingData);

    res.json({ message: 'Pairing started. Check below.', pairingCode });
  } catch (error) {
    logger.error('Error starting pairing:', error);
    res.status(500).json({ error: 'Failed to start pairing' });
  }
});
