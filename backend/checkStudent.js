require("dotenv").config();

const db = require("./db");
const bcrypt = require("bcryptjs");

async function checkStudent() {
    try {
        const [rows] = await db.promise().query(
            "SELECT password_hash, must_change_password FROM students WHERE student_id = ?",
            ["24KB1A05N4"]
        );

        if (rows.length === 0) {
            console.log("Student not found");
            return;
        }

        console.log("Student found:", true);

        const matches = await bcrypt.compare(
            "24KB1A05N4",
            rows[0].password_hash
        );

        console.log("Initial password matches:", matches);
        console.log("Must change password:", rows[0].must_change_password);

    } catch (error) {
        console.log("Error:", error.message);
    } finally {
        db.end();
    }
}

checkStudent();