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

// DEBUG - remove after fixing
console.log("🔍 ENV CHECK:", {
  MYSQLHOST: process.env.MYSQLHOST,
  MYSQLPORT: process.env.MYSQLPORT,
  MYSQLUSER: process.env.MYSQLUSER,
  MYSQLDATABASE: process.env.MYSQLDATABASE,
  hasPassword: !!process.env.MYSQLPASSWORD
});

const isRailway = process.env.MYSQLHOST !== undefined;

const db = mysql.createPool({
  host: isRailway ? process.env.MYSQLHOST : process.env.DB_HOST,
  user: isRailway ? process.env.MYSQLUSER : process.env.DB_USER,
  password: isRailway ? process.env.MYSQLPASSWORD : process.env.DB_PASSWORD,
  database: isRailway ? process.env.MYSQLDATABASE : process.env.DB_NAME,
  port: isRailway ? parseInt(process.env.MYSQLPORT) : parseInt(process.env.DB_PORT),
  ssl: isRailway ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ DB Connection Failed:", err.message, err.code);
  } else {
    console.log("✅ MySQL Connected Successfully");
    connection.release();
  }
});

module.exports = db.promise();