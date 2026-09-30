const mysql = require('mysql2');
require('dotenv').config();

const sslOptions = process.env.DB_SSL === 'true'
    ? {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
        ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {})
    }
    : undefined;

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ...(sslOptions ? { ssl: sslOptions } : {}),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();