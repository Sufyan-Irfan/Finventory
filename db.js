// const mysql = require('mysql');

// const db = mysql.createConnection({
//     host: 'localhost',
//     user: 'root',
//     password: '',
//     database: 'inventory_management'
// });

// db.connect((err) => {
//     if (err) {
//         console.error('Database connection failed:', err.stack);
//         return;
//     }
//     console.log('Connected to MySQL');
// });

// module.exports = db;

// const mysql = require('mysql2');
// const pool = mysql.createPool({
//   host: 'localhost',
//   user: 'root',
//   password: '',
//   database: 'ledger_db'
// });
// module.exports = pool.promise();

require("dotenv").config();
const mysql = require("mysql2");

const pool = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME,
  port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT) || 3306,
  ssl: process.env.MYSQLHOST ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

pool.getConnection((err, connection) => {
  if (err) {
    console.error("❌ DB Connection Failed:", err.message, err.code);
  } else {
    console.log("✅ MySQL Connected Successfully");
    connection.release();
  }
});

module.exports = pool.promise();