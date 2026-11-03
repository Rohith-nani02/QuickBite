require("dotenv").config();

const bcrypt = require("bcryptjs");
const db = require("./db");

const rollNumbers = [
  "24KB1A05N4",
  "24KB1A05FZ",
  "24KB1A05FE",
  "24KB1A05L0",
  "24KB1A05P5",
  "24KB1A05P3",
  "24KB1A05M9",
  "24KB1A05MR",
  "24KB1A05CC",
  "24KB1A05JK"
];

async function seedStudents() {
  try {
    for (const rollNumber of rollNumbers) {
      const passwordHash = await bcrypt.hash(rollNumber, 10);

      await db.promise().query(
        `INSERT INTO students (student_id, password_hash, must_change_password)
         VALUES (?, ?, TRUE)
         ON DUPLICATE KEY UPDATE student_id = student_id`,
        [rollNumber, passwordHash]
      );
    }

    console.log("10 student accounts processed successfully.");
  } catch (error) {
    console.error("Student seeding failed:", error.message);
  } finally {
    db.end();
  }
}

seedStudents();