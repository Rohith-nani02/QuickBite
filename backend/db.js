
require("dotenv").config();

const mysql = require("mysql2");

const isProduction = process.env.NODE_ENV === "production";

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || "localhost",
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQLUSER || process.env.DB_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || "smart_canteen_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

if (isProduction) {
  const required = ["MYSQLHOST", "MYSQLUSER", "MYSQLPASSWORD", "MYSQLDATABASE"];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Railway MySQL environment variables: ${missing.join(", ")}`
    );
  }
}

const db = mysql.createPool(config);

db.getConnection((err, connection) => {
  if (err) {
    console.error("MySQL connection failed:", err.message);
    return;
  }

  console.log("QuickBite MySQL connection established successfully!");

  connection.release();
});

db.on("error", (err) => {
  console.error("MySQL pool error:", err.message);
});

module.exports = db;
