const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const db = require('./db');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Serve only the known frontend entry pages. API routes remain below /api.
const frontendPages = new Set(['index.html', 'login.html', 'dashboard.html', 'admin.html']);
app.get(['/', '/index.html', '/login.html', '/dashboard.html', '/admin.html'], (req, res, next) => {
    const fileName = req.path === '/' ? 'index.html' : req.path.slice(1);
    if (!frontendPages.has(fileName)) return next();

    res.sendFile(path.join(__dirname, fileName), error => {
        if (error) next(error);
    });
});

const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_SECRET_KEY_YUGATHRA_2026';

function normalizePhone(value) {
    let phone = String(value || '').trim().replace(/[^\d+]/g, '');
    if (phone.startsWith('+')) phone = phone.slice(1);
    if (phone.startsWith('0')) phone = `94${phone.slice(1)}`;
    return phone;
}

function isStrongPassword(password) {
    return typeof password === 'string' &&
        password.length >= 8 &&
        /[a-z]/.test(password) &&
        /[A-Z]/.test(password) &&
        /\d/.test(password) &&
        /[^A-Za-z\d]/.test(password);
}

function toPublicPhotoUrl(value, req) {
    if (!value) return null;

    const raw = String(value).trim();
    if (!raw) return null;
    if (/^(data:image\/|https?:\/\/)/i.test(raw)) return raw;

    let normalized = raw.replace(/\\/g, '/');
    const uploadsIndex = normalized.toLowerCase().indexOf('/uploads/');
    if (uploadsIndex >= 0) {
        normalized = normalized.slice(uploadsIndex + 1);
    } else {
        normalized = `uploads/${path.basename(normalized)}`;
    }

    return `${req.protocol}://${req.get('host')}/${normalized.replace(/^\/+/, '')}`;
}

// ONLINE USERS TRACKING SYSTEM (SOCKET.IO)
const onlineUsers = new Map(); // userId -> socketId

io.on('connection', (socket) => {
    socket.on('user_connected', (userId) => {
        if (userId) {
            onlineUsers.set(String(userId), socket.id);
            io.emit('user_status_change', { userId: String(userId), isOnline: true });
        }
    });

    socket.on('disconnect', () => {
        for (let [userId, socketId] of onlineUsers.entries()) {
            if (socketId === socket.id) {
                onlineUsers.delete(userId);
                io.emit('user_status_change', { userId: String(userId), isOnline: false });
                break;
            }
        }
    });
});

// WHATSAPP CLIENT SETUP
let latestQR = null;

const whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
    puppeteer: {
        executablePath: process.env.CHROME_PATH || undefined,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote'
        ]
    }
});

whatsappClient.on('qr', (qr) => {
    latestQR = qr;
    io.emit('whatsapp_qr', qr);
    console.log('QR CODE generated. Open /whatsapp-qr to scan it.');
});

whatsappClient.on('ready', () => {
    latestQR = null;
    io.emit('whatsapp_ready');
    console.log('WhatsApp Web Connected!');
});

// NOTE: whatsappClient.initialize() is called inside server.listen() at the bottom of this file.

// Helper Function: WhatsApp Message Yawimata
const sendWhatsAppNotification = async (phone, message) => {
    try {
        let formattedPhone = phone.trim();
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '94' + formattedPhone.substring(1);
        } else if (formattedPhone.startsWith('+')) {
            formattedPhone = formattedPhone.substring(1);
        }
        const chatId = `${formattedPhone}@c.us`;
        await whatsappClient.sendMessage(chatId, message);
        console.log(`[WhatsApp Sent] To: ${formattedPhone}`);
        return true;
    } catch (error) {
        console.error('[WhatsApp Send Error]', error);
        return false;
    }
};

// USER AUTH MIDDLEWARE
const verifyUser = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authorization token missing' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token: ' + error.message });
    }
};

// ADMIN MIDDLEWARE
const verifyAdmin = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authorization token missing' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.role === 'admin') {
            req.user = decoded;
            next();
        } else {
            return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
        }
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token: ' + error.message });
    }
};

const otpStore = {};

// AI assistant endpoint
app.post('/api/ai/chat', verifyUser, async (req, res) => {
    try {
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
        if (!message) {
            return res.status(400).json({ success: false, message: 'Message is required.' });
        }
        if (message.length > 2000) {
            return res.status(400).json({ success: false, message: 'Message is too long.' });
        }
        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({
                success: false,
                message: 'The AI assistant is not configured yet. Add OPENAI_API_KEY to the project Secrets.'
            });
        }

        const [profileRows] = await db.execute(`
            SELECT p.first_name, p.gender, p.age, p.occupation, p.district,
                   p.religion, p.caste, p.drinking, p.smoking,
                   p.food_preferences, p.soulmate_preferences
            FROM profiles p
            WHERE p.user_id = ?
            LIMIT 1
        `, [req.user.userId]);

        const profile = profileRows[0] || {};
        const history = Array.isArray(req.body?.history)
            ? req.body.history.slice(-10).filter(item =>
                item &&
                ['user', 'assistant'].includes(item.role) &&
                typeof item.content === 'string'
            ).map(item => ({
                role: item.role,
                content: item.content.slice(0, 2000)
            }))
            : [];

        const systemPrompt = `
            You are the Yugathra Assistant inside a Sri Lankan matrimonial dashboard.
            Be warm, concise, and practical. Help with profile completion, search filters,
            shortlists, proposals, privacy, and respectful matrimonial communication.
            You may use the signed-in user's own profile context below to give useful guidance.
            Never reveal, guess, or help obtain anyone's phone number, email, NIC, income,
            private photo, password, OTP, or admin-only information. Phone numbers are
            acceptance-gated by the application. Do not claim to have changed data or sent
            a proposal; explain that the user must use the dashboard controls.
            If asked for legal, medical, financial, or safety advice, recommend a qualified
            professional or the appropriate authorities. Do not make compatibility claims
            based on protected or highly sensitive traits. Keep replies under 120 words.
            Signed-in user's profile context:
            ${JSON.stringify({
                name: profile.first_name || null,
                gender: profile.gender || null,
                age: profile.age || null,
                occupation: profile.occupation || null,
                district: profile.district || null,
                religion: profile.religion || null,
                caste: profile.caste || null,
                drinking: profile.drinking || null,
                smoking: profile.smoking || null,
                foodPreferences: profile.food_preferences || null,
                soulmatePreferences: profile.soulmate_preferences || null
            })}
        `.replace(/\s+/g, ' ').trim();

        const upstream = await fetch(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.AI_MODEL || 'gpt-4o-mini',
                temperature: 0.4,
                max_tokens: 220,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...history,
                    { role: 'user', content: message }
                ]
            })
        });

        const payload = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
            console.error('[AI Assistant Error]', upstream.status, payload?.error?.message || 'Provider request failed');
            return res.status(502).json({ success: false, message: 'The AI assistant is temporarily unavailable.' });
        }

        const reply = payload?.choices?.[0]?.message?.content?.trim();
        if (!reply) {
            return res.status(502).json({ success: false, message: 'The AI assistant returned an empty response.' });
        }

        return res.json({ success: true, reply });
    } catch (error) {
        console.error('[AI Assistant Error]', error.message);
        return res.status(500).json({ success: false, message: 'Could not contact the AI assistant.' });
    }
});

// Database Migration Helpers
const profileColumnDefinitions = {
    age: 'INT NULL',
    drinking: 'VARCHAR(50) NULL',
    smoking: 'VARCHAR(50) NULL',
    food_preferences: 'TEXT NULL',
    soulmate_preferences: 'TEXT NULL'
};

async function ensureProfileColumns() {
    for (const [column, definition] of Object.entries(profileColumnDefinitions)) {
        const [columns] = await db.execute(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'profiles'
              AND COLUMN_NAME = ?
        `, [column]);
        if (columns.length === 0) {
            await db.execute(`ALTER TABLE profiles ADD COLUMN ${column} ${definition}`);
            console.log(`[DB Migration] Added profiles.${column}`);
        }
    }
}

async function ensureAuthColumns() {
    const [columns] = await db.execute(`
        SELECT COLUMN_NAME, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users'
          AND COLUMN_NAME = 'email'
    `);

    if (columns.length > 0 && columns[0].IS_NULLABLE === 'NO') {
        await db.execute('ALTER TABLE users MODIFY email VARCHAR(255) NULL');
        console.log('[DB Migration] Made users.email optional; WhatsApp number is the login identifier.');
    }
}

// 1. SEND WHATSAPP OTP API
app.post('/api/v1/auth/send-otp', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Phone number required' });
        }

        const formattedPhone = normalizePhone(phone);
        if (!/^94\d{9}$/.test(formattedPhone)) {
            return res.status(400).json({ success: false, message: 'Enter a valid Sri Lankan WhatsApp number.' });
        }

        const chatId = `${formattedPhone}@c.us`;
        const generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore[formattedPhone] = generatedOTP;

        await whatsappClient.sendMessage(chatId, `[Yugathra.lk] OTP: *${generatedOTP}*`);

        return res.status(200).json({ success: true, message: 'OTP Sent!' });

    } catch (error) {
        console.error('[WhatsApp Send Error]', error);
        return res.status(500).json({ success: false, message: 'Error sending OTP' });
    }
});

// 2. VERIFY OTP & REGISTER
app.post('/api/v1/auth/verify-and-register', async (req, res) => {
    try {
        let { firstName, lastName, password, phone, otp } = req.body;
        if (!firstName?.trim() || !lastName?.trim() || !password || !phone || !otp) {
            return res.status(400).json({ success: false, message: 'First name, last name, WhatsApp number, password, and OTP are required.' });
        }
        if (!isStrongPassword(password)) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters and include uppercase, lowercase, number, and symbol.'
            });
        }

        const formattedPhone = normalizePhone(phone);
        if (!/^94\d{9}$/.test(formattedPhone)) {
            return res.status(400).json({ success: false, message: 'Enter a valid Sri Lankan WhatsApp number.' });
        }

        if (otpStore[formattedPhone] !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        delete otpStore[formattedPhone];
        const hashedPassword = await bcrypt.hash(password, 10);

        const [existingUsers] = await db.execute('SELECT id FROM users WHERE phone = ? LIMIT 1', [formattedPhone]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'This WhatsApp number is already registered.' });
        }

        const sql = `INSERT INTO users (email, password_hash, phone, role, is_phone_verified, is_verified_by_admin) VALUES (NULL, ?, ?, 'user', TRUE, 0)`;
        const [result] = await db.execute(sql, [hashedPassword, formattedPhone]);
        const insertedUserId = result.insertId;
        const token = jwt.sign(
            { userId: insertedUserId, phone: formattedPhone, role: 'user' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        return res.status(201).json({ 
            success: true, 
            message: 'Registration successful! Pending Admin Approval.',
            userId: insertedUserId,
            token
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'User already exists' });
        }
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

// 3. COMPLETE PROFILE SETUP
app.post('/api/profiles/complete-setup', verifyUser, async (req, res) => {
    try {
        const {
            firstName, lastName, nicNumber, gender, dob, heightCm,
            maritalStatus, childrenStatus, education, occupation, monthlyIncome,
            residenceType, jobCountry, district, religion, caste, drinking, smoking,
            foodPreferences, soulmate_preferences, motherTongue,
            motherName, motherProfession, motherAge,
            fatherName, fatherProfession, fatherAge,
            aboutMyself, publicPhoto, isPhotoVisible, verificationSelfie, age,
            drinkingHabit, smokingHabit, foodPreference, partnerPreferences
        } = req.body;

        const userId = req.user.userId;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID missing' });
        }

        const normalizedDrinking = drinking ?? drinkingHabit ?? null;
        const normalizedSmoking = smoking ?? smokingHabit ?? null;
        const normalizedFoodPreferences = foodPreferences ?? foodPreference ?? null;
        const normalizedSoulmatePreferences = soulmate_preferences ?? partnerPreferences ?? '';

        const sql = `
            INSERT INTO profiles 
            (user_id, first_name, last_name, nic_number, gender, dob, height_cm, 
             marital_status, children_status, education, occupation, monthly_income, 
             residence_type, job_country, district, religion, caste, drinking, smoking,
             food_preferences, soulmate_preferences, mother_tongue, 
             mother_name, mother_profession, mother_age, father_name, father_profession, father_age,
             about_myself, public_photo, is_photo_visible, verification_selfie, age)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            userId, firstName || '', lastName || '', nicNumber || '', gender || 'Male',
            dob || '1990-01-01', heightCm || 160, maritalStatus || 'Unmarried', childrenStatus || 'No Children',
            education || '', occupation || '', monthlyIncome || '', residenceType || 'Local',
            jobCountry || 'Sri Lanka', district || '', religion || '', caste || 'Prefer Not to Say',
            normalizedDrinking, normalizedSmoking, normalizedFoodPreferences, normalizedSoulmatePreferences,
            motherTongue || 'Sinhala', motherName || null, motherProfession || null,
            motherAge ? parseInt(motherAge) : null, fatherName || null, fatherProfession || null,
            fatherAge ? parseInt(fatherAge) : null, aboutMyself || '',
            publicPhoto || null, isPhotoVisible !== undefined ? isPhotoVisible : true,
            verificationSelfie || null, age ? parseInt(age) : null
        ];

        await db.execute(sql, values);

        return res.status(200).json({ success: true, message: 'Profile saved' });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

// 4. LOGIN API
app.post('/api/v1/auth/login', async (req, res) => {
    try {
        const identifier = String(req.body?.identifier || req.body?.phone || req.body?.email || '').trim();
        const password = req.body?.password;
        const formattedPhone = normalizePhone(identifier);
        if (!identifier || !password) {
            return res.status(400).json({ success: false, message: 'WhatsApp number and password are required.' });
        }

        const [users] = await db.execute(`
            SELECT *
            FROM users
            WHERE phone = ?
               OR (role = 'admin' AND email = ?)
            ORDER BY CASE WHEN phone = ? THEN 0 ELSE 1 END
            LIMIT 1
        `, [formattedPhone, identifier, formattedPhone]);
        if (users.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const userRole = user.role || 'user';
        const approvalStatus = Number(user.is_verified_by_admin);

        if (userRole !== 'admin') {
            if (approvalStatus === 0 || Number.isNaN(approvalStatus)) {
                return res.status(403).json({
                    success: false,
                    message: 'ඔබගේ ගිණුම තවදුරටත් Admin අනුමැතිය (Admin Approval) අපේක්ෂාවෙන් පවතී. කරුණාකර අනුමත වන තෙක් රැඳී සිටින්න.'
                });
            } else if (approvalStatus === 2) {
                return res.status(403).json({
                    success: false,
                    message: 'ඔබගේ ලියාපදිංචි ඉල්ලීම Admin විසින් ප්‍රතික්ෂේප කර ඇත.'
                });
            } else if (approvalStatus === 3) {
                return res.status(403).json({
                    success: false,
                    message: 'ඔබගේ ගිණුම තාවකාලිකව අත්හිටුවා ඇත (Blocked). කරුණාකර පරිපාලක අමතන්න.'
                });
            }
        }

        const token = jwt.sign({ userId: user.id, phone: user.phone, role: userRole }, JWT_SECRET, { expiresIn: '7d' });

        return res.status(200).json({
            success: true,
            token,
            userId: user.id,
            role: userRole,
            is_verified_by_admin: approvalStatus
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server Error: ' + error.message });
    }
});

// GET LOGGED-IN USER PROFILE STATUS
app.get('/api/v1/user/my-profile', verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const [rows] = await db.execute(`
            SELECT 
                u.id, u.email, u.phone, u.is_verified_by_admin,
                p.first_name AS firstName, p.last_name AS lastName, p.gender,
                COALESCE(p.age, CASE 
                    WHEN p.dob IS NOT NULL AND p.dob != '0000-00-00' AND p.dob != ''
                    THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(p.dob, '%Y-%m-%d'), CURDATE())
                    ELSE NULL
                END) AS age,
                p.occupation, p.district, p.caste, p.drinking, p.smoking,
                p.food_preferences, p.soulmate_preferences,
                CASE WHEN p.is_photo_visible = 1 THEN 'public' ELSE 'private' END AS photoPrivacy
            FROM users u
            LEFT JOIN profiles p ON u.id = p.user_id
            WHERE u.id = ?
        `, [userId]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = rows[0];
        const approvalStatus = Number(user.is_verified_by_admin);
        let status = 'Approved';
        if (approvalStatus === 0 || Number.isNaN(approvalStatus)) status = 'Pending';
        else if (approvalStatus === 2) status = 'Rejected';
        else if (approvalStatus === 3) status = 'Blocked';

        return res.status(200).json({
            success: true,
            user: {
                id: user.id,
                name: user.firstName ? `${user.firstName} ${user.lastName || ''}` : 'User',
                email: user.email,
                phone: user.phone,
                gender: user.gender,
                age: user.age,
                occupation: user.occupation,
                district: user.district,
                caste: user.caste,
                drinking: user.drinking,
                smoking: user.smoking,
                food_preferences: user.food_preferences,
                soulmate_preferences: user.soulmate_preferences,
                photoPrivacy: user.photoPrivacy,
                status: status
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// ADMIN ENDPOINTS
app.get('/api/v1/admin/pending-requests', verifyAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT 
                u.id AS _id, u.email, u.phone, u.is_verified_by_admin,
                p.first_name AS firstName, p.last_name AS lastName, 
                p.nic_number AS nicNumber, p.district, p.occupation
            FROM users u
            LEFT JOIN profiles p ON u.id = p.user_id
            WHERE u.is_verified_by_admin = 0 OR u.is_verified_by_admin IS NULL
            ORDER BY u.created_at DESC
        `;
        const [rows] = await db.execute(sql);
        return res.status(200).json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.get('/api/v1/admin/approved-users', verifyAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT 
                u.id AS _id, u.email, u.phone,
                p.first_name AS firstName, p.last_name AS lastName, 
                p.gender, p.district, p.occupation
            FROM users u
            LEFT JOIN profiles p ON u.id = p.user_id
            WHERE u.is_verified_by_admin = 1
            ORDER BY u.created_at DESC
        `;
        const [rows] = await db.execute(sql);
        return res.status(200).json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.post('/api/v1/admin/approve-user', verifyAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

        const [result] = await db.execute('UPDATE users SET is_verified_by_admin = 1 WHERE id = ?', [userId]);

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const [users] = await db.execute(`
            SELECT u.phone, p.first_name 
            FROM users u 
            LEFT JOIN profiles p ON u.id = p.user_id 
            WHERE u.id = ?
        `, [userId]);

        if (users.length > 0) {
            const user = users[0];
            const name = user.first_name || 'පරිශීලකයා';
            const message = `සුබ දවසක් ${name}, Yugathra.lk හි ඔබේ ගිණුම සාර්ථකව අනුමත (Approve) කරන ලදී! දැන් ඔබට Yugathra.lk වෙත ලොග් විය හැක.`;
            await sendWhatsAppNotification(user.phone, message);
        }

        return res.status(200).json({ success: true, message: 'User approved successfully and WhatsApp message sent!' });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.post('/api/v1/admin/reject-user', verifyAdmin, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

        const [result] = await db.execute('UPDATE users SET is_verified_by_admin = 2 WHERE id = ?', [userId]);

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const [users] = await db.execute(`
            SELECT u.phone, p.first_name 
            FROM users u 
            LEFT JOIN profiles p ON u.id = p.user_id 
            WHERE u.id = ?
        `, [userId]);

        if (users.length > 0) {
            const user = users[0];
            const name = user.first_name || 'පරිශීලකයා';
            const rejectionReason = reason || 'තොරතුරු අපූර්ණයි';
            const message = `සුබ දවසක් ${name}, Yugathra.lk හි ඔබේ ලියාපදිංචි ඉල්ලීම ප්‍රතික්ෂේප කරන ලදී. හේතුව: ${rejectionReason}`;
            await sendWhatsAppNotification(user.phone, message);
        }

        return res.status(200).json({ success: true, message: 'User rejected successfully and WhatsApp message sent!' });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.get('/api/v1/admin/stats', verifyAdmin, async (req, res) => {
    try {
        const [total] = await db.execute('SELECT COUNT(*) AS count FROM users WHERE role = "user"');
        const [pending] = await db.execute('SELECT COUNT(*) AS count FROM users WHERE role = "user" AND (is_verified_by_admin = 0 OR is_verified_by_admin IS NULL)');
        const [approved] = await db.execute('SELECT COUNT(*) AS count FROM users WHERE role = "user" AND is_verified_by_admin = 1');
        const [rejected] = await db.execute('SELECT COUNT(*) AS count FROM users WHERE role = "user" AND is_verified_by_admin = 2');
        const [blocked] = await db.execute('SELECT COUNT(*) AS count FROM users WHERE role = "user" AND is_verified_by_admin = 3');

        return res.status(200).json({
            success: true,
            stats: {
                totalUsers: total[0].count,
                pendingUsers: pending[0].count,
                approvedUsers: approved[0].count,
                rejectedUsers: rejected[0].count,
                blockedUsers: blocked[0].count
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.get('/api/v1/admin/online-users', verifyAdmin, async (req, res) => {
    try {
        const onlineUserIds = [...onlineUsers.keys()];
        if (onlineUserIds.length === 0) {
            return res.json({ success: true, count: 0, data: [] });
        }

        const placeholders = onlineUserIds.map(() => '?').join(', ');
        const [rows] = await db.execute(`
            SELECT
                u.id AS userId, u.phone, u.created_at,
                p.first_name AS firstName, p.last_name AS lastName,
                p.gender, p.district, p.occupation, p.public_photo AS photo
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.role = 'user' AND u.id IN (${placeholders})
            ORDER BY p.first_name ASC
        `, onlineUserIds);

        return res.json({
            success: true,
            count: rows.length,
            data: rows.map(user => ({
                ...user,
                photo: toPublicPhotoUrl(user.photo, req),
                isOnline: true
            }))
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Could not load online users: ' + error.message });
    }
});

app.get('/api/v1/admin/activity', verifyAdmin, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                u.id AS userId, u.phone, u.created_at AS createdAt,
                u.is_verified_by_admin AS approvalStatus,
                p.first_name AS firstName, p.last_name AS lastName,
                p.gender, p.district, p.occupation
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.role = 'user'
            ORDER BY u.created_at DESC
            LIMIT 20
        `);

        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Could not load account activity: ' + error.message });
    }
});

app.get('/api/v1/admin/users', verifyAdmin, async (req, res) => {
    try {
        const { status = 'all', search = '' } = req.query;

        let sql = `
            SELECT 
                u.id AS _id, u.email, u.phone, u.is_verified_by_admin, u.created_at,
                p.first_name AS firstName, p.last_name AS lastName, 
                p.nic_number AS nicNumber, p.district, p.occupation, p.gender
            FROM users u
            LEFT JOIN profiles p ON u.id = p.user_id
            WHERE u.role = 'user'
        `;

        const queryParams = [];

        if (status === 'pending') {
            sql += ` AND (u.is_verified_by_admin = 0 OR u.is_verified_by_admin IS NULL)`;
        } else if (status === 'approved') {
            sql += ` AND u.is_verified_by_admin = 1`;
        } else if (status === 'rejected') {
            sql += ` AND u.is_verified_by_admin = 2`;
        } else if (status === 'blocked') {
            sql += ` AND u.is_verified_by_admin = 3`;
        }

        if (search.trim() !== '') {
            sql += ` AND (p.first_name LIKE ? OR p.last_name LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR p.nic_number LIKE ?)`;
            const searchTerm = `%${search.trim()}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        sql += ` ORDER BY u.created_at DESC`;

        const [rows] = await db.execute(sql, queryParams);

        return res.status(200).json({ success: true, count: rows.length, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

// YAWATKALINA KALA ADMIN USER DETAILS API (Public Photo සහ Verification Selfie වෙන වෙනම URL සමඟ සකස් කිරීම)
app.get('/api/v1/admin/user-details/:id', verifyAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const [rows] = await db.execute(`
            SELECT 
                u.id AS userId, u.email, u.phone, u.is_verified_by_admin, u.created_at AS registeredAt,
                p.*
            FROM users u
            LEFT JOIN profiles p ON u.id = p.user_id
            WHERE u.id = ?
        `, [userId]);

        if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const userProfile = rows[0];

        // ෆොටෝ දෙකම ඇඩ්මින්ට නිවැරදිව බලාගත හැකි වන පරිදි URL සකස් කිරීම
        userProfile.public_photo = toPublicPhotoUrl(userProfile.public_photo, req);
        userProfile.verification_selfie = toPublicPhotoUrl(userProfile.verification_selfie, req);

        return res.status(200).json({ success: true, user: userProfile });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.post('/api/v1/admin/toggle-block', verifyAdmin, async (req, res) => {
    try {
        const { userId, block } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

        const newStatus = block ? 3 : 1;
        const [result] = await db.execute('UPDATE users SET is_verified_by_admin = ? WHERE id = ?', [newStatus, userId]);

        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'User not found' });

        return res.status(200).json({ 
            success: true, 
            message: block ? 'User blocked successfully!' : 'User unblocked successfully!' 
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    }
});

app.post('/api/v1/admin/resend-whatsapp', verifyAdmin, async (req, res) => {
    try {
        const { phone, message } = req.body;
        if (!phone || !message) return res.status(400).json({ success: false, message: 'Phone number and message required' });

        const sent = await sendWhatsAppNotification(phone, message);
        if (sent) return res.status(200).json({ success: true, message: 'WhatsApp notification sent successfully!' });
        else return res.status(500).json({ success: false, message: 'Failed to send WhatsApp message' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error: ' + error.message });
    }
});

// =========================================================================
// 🌐 USER MATCHES, DETAILS, SHORTLIST & PROPOSAL SYSTEM
// =========================================================================

// 1. MATCHES LIST
app.get('/api/profiles/matches', verifyUser, async (req, res) => {
    try {
        const currentUserId = req.user.userId;

        const [rows] = await db.execute(`
            SELECT 
                p.id AS id, 
                p.user_id AS userId,
                CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(LEFT(p.last_name, 1), ''), '.') AS name, 
                p.gender,
                COALESCE(p.occupation, 'Not Specified') AS occupation, 
                COALESCE(p.district, 'Not Specified') AS district, 
                COALESCE(p.religion, 'Not Specified') AS religion,
                COALESCE(p.caste, 'Not Specified') AS caste,
                p.drinking,
                p.smoking,
                p.food_preferences,
                p.soulmate_preferences,
                p.public_photo AS photo,
                CASE WHEN p.is_photo_visible = 1 THEN 'public' ELSE 'private' END AS photoPrivacy,
                COALESCE(p.age, CASE 
                    WHEN p.dob IS NOT NULL AND p.dob != '0000-00-00' AND p.dob != '' 
                    THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(p.dob, '%Y-%m-%d'), CURDATE())
                    ELSE NULL 
                END) AS age,
                EXISTS(SELECT 1 FROM shortlists s WHERE s.user_id = ? AND s.shortlisted_user_id = p.user_id) AS isShortlisted
            FROM profiles p
            INNER JOIN users u ON p.user_id = u.id
            WHERE u.is_verified_by_admin = 1 AND u.role = 'user' AND u.id != ?
            ORDER BY p.created_at DESC
        `, [currentUserId, currentUserId]);

        const profilesWithOnlineStatus = rows.map(p => ({
            ...p,
            photo: toPublicPhotoUrl(p.photo, req),
            isOnline: onlineUsers.has(String(p.userId))
        }));

        return res.status(200).json({ success: true, profiles: profilesWithOnlineStatus });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error fetching profiles: ' + error.message });
    }
});

// 2. GET SINGLE USER FULL PROFILE DETAILS
app.get('/api/profiles/details/:profileId', verifyUser, async (req, res) => {
    try {
        const loggedInUserId = req.user.userId;
        const targetProfileId = req.params.profileId;

        const [profiles] = await db.execute(`
            SELECT
                p.id, p.user_id, p.first_name, p.last_name, p.gender, p.dob,
                COALESCE(p.age, CASE
                    WHEN p.dob IS NOT NULL AND p.dob != '0000-00-00' AND p.dob != ''
                    THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(p.dob, '%Y-%m-%d'), CURDATE())
                    ELSE NULL
                END) AS age,
                p.height_cm, p.marital_status, p.children_status, p.education,
                p.occupation, p.residence_type, p.job_country, p.district,
                p.religion, p.caste, p.drinking, p.smoking,
                p.food_preferences, p.soulmate_preferences, p.about_myself,
                p.public_photo, p.is_photo_visible, p.monthly_income, u.phone
            FROM profiles p
            INNER JOIN users u ON p.user_id = u.id
            WHERE p.id = ? OR p.user_id = ?
            ORDER BY CASE WHEN p.user_id = ? THEN 1 ELSE 2 END
            LIMIT 1
        `, [targetProfileId, targetProfileId, targetProfileId]);

        if (profiles.length === 0) {
            return res.status(404).json({ success: false, message: 'Profile not found' });
        }

        const profile = profiles[0];
        const targetUserId = profile.user_id;

        const [proposals] = await db.execute(`
            SELECT status FROM proposals
            WHERE (sender_id = ? AND receiver_id = ?) 
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY CASE
                WHEN status = 'accepted' THEN 1
                WHEN status = 'pending' THEN 2
                ELSE 3
            END, created_at DESC
            LIMIT 1
        `, [loggedInUserId, targetUserId, targetUserId, loggedInUserId]);

        let proposalStatus = 'none';
        let canViewPhone = false;

        if (proposals.length > 0) {
            proposalStatus = proposals[0].status;
            if (proposalStatus === 'accepted') {
                canViewPhone = true;
            }
        }

        if (!canViewPhone) {
            profile.phone = null;
            profile.monthly_income = null;
        }
        profile.public_photo = toPublicPhotoUrl(profile.public_photo, req);

        return res.status(200).json({
            success: true,
            profile: profile,
            proposalStatus: proposalStatus,
            canViewPhone: canViewPhone,
            isOnline: onlineUsers.has(String(targetUserId))
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error fetching details: ' + error.message });
    }
});

// 3. SEND PROPOSAL REQUEST API
app.post('/api/proposals/send', verifyUser, async (req, res) => {
    try {
        const senderId = req.user.userId;
        const { receiverUserId } = req.body;

        if (!receiverUserId) return res.status(400).json({ success: false, message: 'Receiver User ID missing' });
        if (senderId == receiverUserId) return res.status(400).json({ success: false, message: 'You cannot send a request to yourself' });

        const [users] = await db.execute(`
            SELECT
                u.id, u.role, u.is_verified_by_admin, p.gender
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.id IN (?, ?)
        `, [senderId, receiverUserId]);

        const sender = users.find(user => String(user.id) === String(senderId));
        const receiver = users.find(user => String(user.id) === String(receiverUserId));

        if (!receiver || receiver.role !== 'user' || receiver.is_verified_by_admin !== 1) {
            return res.status(404).json({ success: false, message: 'The selected profile is not available.' });
        }

        if (
            sender &&
            sender.gender &&
            receiver.gender &&
            String(sender.gender).trim().toLowerCase() === String(receiver.gender).trim().toLowerCase()
        ) {
            return res.status(400).json({ success: false, message: 'Requests can only be sent to the other gender.' });
        }

        const [existing] = await db.execute(`
            SELECT id, status, sender_id, receiver_id
            FROM proposals
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
            ORDER BY created_at DESC
            LIMIT 1
        `, [senderId, receiverUserId, receiverUserId, senderId]);

        if (existing.length > 0 && ['pending', 'accepted'].includes(existing[0].status)) {
            return res.status(400).json({ success: false, message: 'A request already exists between these profiles.' });
        }

        await db.execute(`
            INSERT INTO proposals (sender_id, receiver_id, status) VALUES (?, ?, 'pending')
        `, [senderId, receiverUserId]);

        return res.status(200).json({ success: true, message: 'Proposal request sent successfully!' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error sending request: ' + error.message });
    }
});

// 4. GET RECEIVED PROPOSALS API
app.get('/api/proposals/received', verifyUser, async (req, res) => {
    try {
        const receiverId = req.user.userId;
        const [rows] = await db.execute(`
            SELECT 
                pr.id, pr.status, pr.sender_id,
                CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(LEFT(p.last_name, 1), ''), '.') AS sender_name,
                COALESCE(p.district, 'Not Specified') AS sender_district,
                COALESCE(p.occupation, 'Not Specified') AS sender_occupation,
                COALESCE(p.religion, 'Not Specified') AS religion,
                COALESCE(p.caste, 'Not Specified') AS caste,
                COALESCE(p.drinking, 'Not Specified') AS drinking,
                COALESCE(p.smoking, 'Not Specified') AS smoking,
                p.food_preferences,
                p.soulmate_preferences,
                COALESCE(p.age, CASE
                    WHEN p.dob IS NOT NULL AND p.dob != '0000-00-00' AND p.dob != ''
                    THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(p.dob, '%Y-%m-%d'), CURDATE())
                    ELSE NULL
                END) AS age,
                CASE WHEN pr.status = 'accepted' THEN p.monthly_income ELSE NULL END AS monthly_income,
                p.public_photo AS public_photo,
                CASE WHEN pr.status = 'accepted' THEN u.phone ELSE NULL END AS sender_phone
            FROM proposals pr
            INNER JOIN profiles p ON pr.sender_id = p.user_id
            INNER JOIN users u ON pr.sender_id = u.id
            WHERE pr.receiver_id = ?
            ORDER BY pr.created_at DESC
        `, [receiverId]);

        const proposalsWithOnlineStatus = rows.map(pr => ({
            ...pr,
            public_photo: toPublicPhotoUrl(pr.public_photo, req),
            isOnline: onlineUsers.has(String(pr.sender_id))
        }));

        return res.status(200).json({ success: true, data: proposalsWithOnlineStatus });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error fetching proposals: ' + error.message });
    }
});

// 5. GET SENT PROPOSALS API
app.get('/api/proposals/sent', verifyUser, async (req, res) => {
    try {
        const senderId = req.user.userId;
        const [rows] = await db.execute(`
            SELECT
                pr.id, pr.status, pr.receiver_id,
                CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(LEFT(p.last_name, 1), ''), '.') AS receiver_name,
                COALESCE(p.gender, '') AS receiver_gender,
                COALESCE(p.district, 'Not Specified') AS receiver_district,
                COALESCE(p.occupation, 'Not Specified') AS receiver_occupation,
                COALESCE(p.religion, 'Not Specified') AS religion,
                COALESCE(p.caste, 'Not Specified') AS caste,
                COALESCE(p.drinking, 'Not Specified') AS drinking,
                COALESCE(p.smoking, 'Not Specified') AS smoking,
                p.food_preferences,
                p.soulmate_preferences,
                COALESCE(p.age, CASE
                    WHEN p.dob IS NOT NULL AND p.dob != '0000-00-00' AND p.dob != ''
                    THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(p.dob, '%Y-%m-%d'), CURDATE())
                    ELSE NULL
                END) AS age,
                p.public_photo AS receiver_photo,
                CASE WHEN pr.status = 'accepted' THEN u.phone ELSE NULL END AS receiver_phone
            FROM proposals pr
            INNER JOIN profiles p ON pr.receiver_id = p.user_id
            INNER JOIN users u ON pr.receiver_id = u.id
            WHERE pr.sender_id = ?
            ORDER BY pr.created_at DESC
        `, [senderId]);

        const requestsWithOnlineStatus = rows.map(request => ({
            ...request,
            receiver_photo: toPublicPhotoUrl(request.receiver_photo, req),
            isOnline: onlineUsers.has(String(request.receiver_id))
        }));

        return res.status(200).json({ success: true, data: requestsWithOnlineStatus });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error fetching sent requests: ' + error.message });
    }
});

// 6. ACCEPT PROPOSAL API
app.post('/api/proposals/accept', verifyUser, async (req, res) => {
    try {
        const receiverId = req.user.userId;
        const { senderUserId } = req.body;

        const [result] = await db.execute(`
            UPDATE proposals SET status = 'accepted' WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'
        `, [senderUserId, receiverId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Proposal request not found' });
        }

        return res.status(200).json({ success: true, message: 'Proposal accepted successfully!' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error accepting proposal: ' + error.message });
    }
});

// 6.1. REJECT / IGNORE PROPOSAL API
app.post('/api/proposals/reject', verifyUser, async (req, res) => {
    try {
        const receiverId = req.user.userId;
        const { senderUserId } = req.body;

        if (!senderUserId) {
            return res.status(400).json({ success: false, message: 'Sender User ID required' });
        }

        const [result] = await db.execute(`
            UPDATE proposals SET status = 'rejected' WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'
        `, [senderUserId, receiverId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Proposal request not found' });
        }

        return res.status(200).json({ success: true, message: 'Proposal ignored/rejected successfully!' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error rejecting proposal: ' + error.message });
    }
});

// 6. SHORTLIST TOGGLE API
app.post('/api/shortlist/toggle', verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { targetUserId } = req.body;

        if (!targetUserId) return res.status(400).json({ success: false, message: 'Target User ID required' });

        const [existing] = await db.execute('SELECT id FROM shortlists WHERE user_id = ? AND shortlisted_user_id = ?', [userId, targetUserId]);

        if (existing.length > 0) {
            await db.execute('DELETE FROM shortlists WHERE user_id = ? AND shortlisted_user_id = ?', [userId, targetUserId]);
            return res.status(200).json({ success: true, isShortlisted: false, message: 'Removed from shortlist' });
        } else {
            await db.execute('INSERT INTO shortlists (user_id, shortlisted_user_id) VALUES (?, ?)', [userId, targetUserId]);
            return res.status(200).json({ success: true, isShortlisted: true, message: 'Added to shortlist' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error toggling shortlist: ' + error.message });
    }
});

// 7. GET MY SHORTLISTED PROFILES API
app.get('/api/shortlist/my-list', verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const [rows] = await db.execute(`
            SELECT 
                p.id AS profileId, p.user_id AS userId,
                CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(LEFT(p.last_name, 1), ''), '.') AS name,
                p.gender,
                COALESCE(p.occupation, 'Not Specified') AS occupation, 
                COALESCE(p.district, 'Not Specified') AS district, 
                p.religion, p.caste, p.drinking, p.smoking,
                p.food_preferences, p.soulmate_preferences,
                p.public_photo AS photo,
                CASE 
                    WHEN p.dob IS NOT NULL AND p.dob != '0000-00-00' AND p.dob != '' 
                    THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(p.dob, '%Y-%m-%d'), CURDATE())
                    ELSE NULL 
                END AS age
            FROM shortlists s
            INNER JOIN profiles p ON s.shortlisted_user_id = p.user_id
            WHERE s.user_id = ?
            ORDER BY s.id DESC
        `, [userId]);

        const shortlistedWithStatus = rows.map(item => ({
            ...item,
            photo: toPublicPhotoUrl(item.photo, req),
            isOnline: onlineUsers.has(String(item.userId))
        }));

        return res.status(200).json({ success: true, data: shortlistedWithStatus, shortlists: shortlistedWithStatus });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error fetching shortlist: ' + error.message });
    }
});

// 8. USER PROFILE UPDATE & PRIVACY SETTINGS
app.put('/api/v1/user/update-profile', verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            age, occupation, district, caste, drinking, smoking,
            foodPreferences, food_preferences,
            partnerPreferences, partner_preferences, soulmate_preferences,
            photoPrivacy
        } = req.body;

        const parsedAge = age === '' || age === undefined || age === null ? null : Number(age);
        if (parsedAge !== null && (!Number.isInteger(parsedAge) || parsedAge < 18 || parsedAge > 100)) {
            return res.status(400).json({ success: false, message: 'Age must be a whole number between 18 and 100.' });
        }

        const normalizedFoodPreferences = foodPreferences ?? food_preferences ?? '';
        const normalizedPartnerPreferences =
            partnerPreferences ?? partner_preferences ?? soulmate_preferences ?? '';
        const normalizedPhotoPrivacy = photoPrivacy === undefined
            ? null
            : photoPrivacy === 'public';

        await db.execute(`
            UPDATE profiles 
            SET age = COALESCE(?, age),
                occupation = COALESCE(NULLIF(?, ''), occupation),
                district = COALESCE(NULLIF(?, ''), district),
                caste = COALESCE(NULLIF(?, ''), caste),
                drinking = COALESCE(NULLIF(?, ''), drinking),
                smoking = COALESCE(NULLIF(?, ''), smoking),
                food_preferences = COALESCE(NULLIF(?, ''), food_preferences),
                soulmate_preferences = COALESCE(NULLIF(?, ''), soulmate_preferences),
                is_photo_visible = COALESCE(?, is_photo_visible)
            WHERE user_id = ?
        `, [
            parsedAge, occupation, district, caste, drinking, smoking,
            normalizedFoodPreferences, normalizedPartnerPreferences,
            normalizedPhotoPrivacy, userId
        ]);

        const [updatedRows] = await db.execute(`
            SELECT
                p.gender, p.age, p.occupation, p.district, p.caste,
                p.drinking, p.smoking, p.food_preferences, p.soulmate_preferences,
                CASE WHEN p.is_photo_visible = 1 THEN 'public' ELSE 'private' END AS photoPrivacy
            FROM profiles p
            WHERE p.user_id = ?
        `, [userId]);

        return res.status(200).json({
            success: true,
            message: 'Profile updated successfully!',
            user: updatedRows[0] || null
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Update failed: ' + error.message });
    }
});

// WHATSAPP QR PAGE (scan once, then remove this route)
app.get('/whatsapp-qr', async (req, res) => {
    if (!latestQR) {
        return res.send('<h2 style="font-family:sans-serif">No QR available. WhatsApp is already connected, or Chrome is still starting. Refresh in 30 seconds.</h2>');
    }
    try {
        const qrImage = await require('qrcode').toDataURL(latestQR);
        res.send(`
            <html><head><meta http-equiv="refresh" content="20"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>WhatsApp QR Code</h2>
                <p>WhatsApp → Linked Devices → Link a device</p>
                <img src="${qrImage}" width="300" height="300">
            </body></html>
        `);
    } catch (error) {
        res.status(500).send('Could not generate QR: ' + error.message);
    }
});

// START SERVER
const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}...`);

    Promise.all([ensureProfileColumns(), ensureAuthColumns()])
        .catch(error => {
            console.error('[DB Migration Error]', error.message);
        });

    whatsappClient.initialize().catch(err => {
        console.error('[WhatsApp Init Error]', err.message);
    });
});
