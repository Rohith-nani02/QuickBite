
require("dotenv").config();

const bcrypt = require("bcryptjs");
const db = require("./db");

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;

async function createAdmin() {
  if (
    !username ||
    username.length > 50 ||
    !password ||
    password.length < 12 ||
    password.length > 200 ||
    password === "ChangeThisToAStrongPassword123!"
  ) {
    console.error(
      "Set a custom admin username and a strong password of at least 12 characters in .env."
    );
    db.end();
    process.exitCode = 1;
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    db.query(
      `INSERT INTO admins (username, password_hash)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
      [username, passwordHash],
      (err) => {
        if (err) {
          console.error("Could not create admin:", err.message);
          db.end();
          process.exitCode = 1;
          return;
        }

        console.log(`Admin account "${username}" created or updated.`);
        console.log("Your password is stored as a hash.");
        db.end();
      }
    );
  } catch (error) {
    console.error("Admin setup failed:", error.message);
    db.end();
    process.exitCode = 1;
  }
}

createAdmin();
