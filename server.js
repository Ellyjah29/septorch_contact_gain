require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createObjectCsvWriter } = require('csv-writer');
const QRCode = require('qrcode');
const Pino = require('pino');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketio = require('socket.io');
const fileUpload = require('express-fileupload');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// Logger Setup
const logger = Pino({
  level: 'debug',
  base: null,
});

// Rate Limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);
app.use(express.json());
app.use(express.static('public')); // Serve static files from "public" folder
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => logger.info('MongoDB Connected'))
  .catch(err => logger.error('MongoDB Error:', err));

// Contacts Schema with email validation tracking
const ContactSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  joinedChannel: { type: Boolean, default: false },
  optedOut: { type: Boolean, default: false },
  invalidEmail: { type: Boolean, default: false }
});
const Contact = mongoose.model('Contact', ContactSchema, 'contacts');

// Email Transporter (Replace with Amazon SES for 500+ emails)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASS
  }
});

// VCF Generation Function
async function generateVCF() {
  try {
    const contacts = await Contact.find({ invalidEmail: false });
    let vcfContent = '';
    contacts.forEach(contact => {
      vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL:${contact.phone}\nEMAIL:${contact.email}\nEND:VCARD\n`;
    });
    fs.writeFileSync('contacts.vcf', vcfContent);
    logger.info('VCF file generated successfully');
  } catch (error) {
    logger.error('Error generating VCF:', error);
  }
}

// Batch Email Sending Function
async function sendEmailsInBatches(emails, batchSize = 100) {
  try {
    const totalBatches = Math.ceil(emails.length / batchSize);

    for (let i = 0; i < totalBatches; i++) {
      const batch = emails.slice(i * batchSize, (i + 1) * batchSize);

      const mailOptions = {
        from: process.env.EMAIL,
        to: batch.join(','),
        subject: 'Your Daily VCF File',
        text: 'Attached is the VCF file containing all contacts.',
        attachments: [{ path: path.join(__dirname, 'contacts.vcf') }]
      };

      const info = await transporter.sendMail(mailOptions);

      // Automatically remove invalid emails
      if (info.rejected && info.rejected.length > 0) {
        await Contact.updateMany(
          { email: { $in: info.rejected } },
          { invalidEmail: true }
        );
        logger.warn(`Removed ${info.rejected.length} invalid emails`);
      }

      // Add delay between batches (1 sec per email to comply with Gmail limits)
      await new Promise(resolve => setTimeout(resolve, batch.length * 1000));
      logger.info(`Batch ${i + 1}/${totalBatches} sent successfully`);
    }
  } catch (error) {
    logger.error('Error sending email batches:', error);
  }
}

// Daily VCF Email at 6:00 AM Nigerian Time
cron.schedule('0 6 * * *', async () => {
  try {
    logger.info('Starting daily VCF process...');

    // Generate fresh VCF
    await generateVCF();

    // Get valid users
    const users = await Contact.find({
      joinedChannel: false,
      optedOut: false,
      invalidEmail: false
    });

    // Extract unique emails
    const emails = [...new Set(users.map(user => user.email))];

    // Send emails in batches
    await sendEmailsInBatches(emails, 100);

    // Send VCF to WhatsApp channel
    await sendVCFtoWhatsAppChannel();

    logger.info('Daily VCF process completed');
  } catch (error) {
    logger.error('Daily process failed:', error);
  }
}, {
  timezone: 'Africa/Lagos' // Nigerian timezone
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
    whatsappSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          logger.warn('Reconnecting WhatsApp bot...');
          startWhatsAppBot();
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp Bot Connected');
        io.emit('whatsappStatus', 'connected');
      } else if (qr) {
        QRCode.toDataURL(qr, (err, url) => {
          if (err) return logger.error('QR Error:', err);
          io.emit('whatsappQR', url);
        });
      }
    });
  } catch (error) {
    logger.error('WhatsApp Bot Error:', error);
  }
}
startWhatsAppBot();

// Send VCF to WhatsApp Channel Function
async function sendVCFtoWhatsAppChannel() {
  try {
    const channelJID = process.env.WHATSAPP_CHANNEL_JID;
    if (!channelJID) {
      logger.error('WhatsApp channel JID not set');
      return;
    }

    await whatsappSock.sendMessage(channelJID, {
      document: fs.readFileSync('contacts.vcf'),
      fileName: 'contacts.vcf',
      mimetype: 'text/vcard',
    });

    logger.info('VCF sent to WhatsApp channel');
  } catch (error) {
    logger.error('Error sending VCF to WhatsApp:', error);
  }
}

// Registration Endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone || !email) return res.status(400).json({ error: 'All fields required' });

    let user = await Contact.findOne({ phone });
    if (!user) {
      user = new Contact({ name, phone, email });
      await user.save();
    }

    res.json({ message: 'Registered successfully' });
  } catch (error) {
    logger.error('Registration Error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Admin API Endpoints
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

app.post('/api/uploadVCF', adminAuth, (req, res) => {
  const vcfFile = req.files.vcfFile;
  vcfFile.mv('contacts.vcf', (err) => {
    if (err) return res.status(500).send(err);
    res.json({ message: 'VCF uploaded successfully' });
  });
});

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
        { id: 'invalidEmail', title: 'Invalid Email' }
      ]
    });
    await csvWriter.writeRecords(users);
    res.download('users.csv');
  } catch (error) {
    logger.error('Export Error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Admin Authentication Middleware
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid admin credentials' });
  }
  next();
}

// Admin Login API
app.post('/api/adminLogin', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ message: 'Login successful' });
});

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Server running' });
});

// Serve Admin Panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start Server
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
