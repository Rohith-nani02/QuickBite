
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

if (
  !process.env.JWT_SECRET ||
  process.env.JWT_SECRET.length < 32 ||
  process.env.JWT_SECRET === "replace_this_with_a_long_random_secret" ||
  process.env.JWT_SECRET.includes("PASTE_")
) {
  console.error("Configure a strong JWT_SECRET in backend/.env");
  process.exit(1);
}

// CORS configuration
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://10.136.59.13:3000",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:5501",
      "http://127.0.0.1:5501",
      "https://quickbite-frontend-delta.vercel.app"
    ],
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// MySQL query wrapper
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

// Razorpay configuration
function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret || !keyId.startsWith("rzp_test_")) {
    throw new Error(
      "Razorpay test credentials are missing or invalid. Check backend/.env."
    );
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret
  });
}

// Validate order details
function validateOrderInput(customerName, items) {
  if (
    typeof customerName !== "string" ||
    !customerName.trim() ||
    customerName.trim().length > 100 ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 50
  ) {
    return false;
  }

  return items.every(
    (item) =>
      item &&
      Number.isSafeInteger(Number(item.id)) &&
      Number(item.id) > 0 &&
      Number.isSafeInteger(Number(item.quantity)) &&
      Number(item.quantity) > 0 &&
      Number(item.quantity) <= 100
  );
}

// Calculate prices from the database
async function getPricedItems(items) {
  const quantities = new Map();

  for (const item of items) {
    const id = Number(item.id);
    const quantity = Number(item.quantity);
    const combined = (quantities.get(id) || 0) + quantity;

    if (combined > 100) {
      throw new Error("Maximum quantity per menu item is 100.");
    }

    quantities.set(id, combined);
  }

  const ids = [...quantities.keys()];
  const placeholders = ids.map(() => "?").join(",");

  const menuItems = await query(
    `SELECT id, name, price
     FROM menu_items
     WHERE is_available = 1
       AND id IN (${placeholders})`,
    ids
  );

  if (menuItems.length !== ids.length) {
    throw new Error("One or more menu items are unavailable.");
  }

  const menuById = new Map(
    menuItems.map((item) => [Number(item.id), item])
  );

  const pricedItems = [];
  let totalPaise = 0;

  for (const [id, quantity] of quantities.entries()) {
    const menuItem = menuById.get(id);

    if (!menuItem) {
      throw new Error("A selected menu item was not found.");
    }

    const unitPricePaise = Math.round(Number(menuItem.price) * 100);

    if (
      !Number.isSafeInteger(unitPricePaise) ||
      unitPricePaise <= 0
    ) {
      throw new Error("A menu item has an invalid price.");
    }

    totalPaise += unitPricePaise * quantity;

    pricedItems.push({
      id,
      name: menuItem.name,
      quantity,
      unitPricePaise
    });
  }

  if (
    !Number.isSafeInteger(totalPaise) ||
    totalPaise <= 0 ||
    totalPaise > 100000000
  ) {
    throw new Error("Order total is outside the permitted range.");
  }

  return { pricedItems, totalPaise };
}

// Save order and order items
async function saveOrder(customerName, pricedItems, totalPaise, method) {
  const totalAmount = (totalPaise / 100).toFixed(2);

  const orderResult = await query(
    `INSERT INTO orders
       (customer_name, total_amount, status, payment_method, payment_status)
     VALUES (?, ?, 'Pending', ?, 'Pending')`,
    [customerName.trim(), totalAmount, method]
  );

  const orderId = orderResult.insertId;

  try {
    const values = pricedItems.map((item) => [
      orderId,
      item.id,
      item.name,
      item.quantity,
      (item.unitPricePaise / 100).toFixed(2)
    ]);

    await query(
      `INSERT INTO order_items
         (order_id, menu_item_id, item_name, quantity, unit_price)
       VALUES ?`,
      [values]
    );
  } catch (error) {
    await query(
      "DELETE FROM orders WHERE id = ?",
      [orderId]
    ).catch(() => {});

    throw error;
  }

  return orderId;
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Smart Canteen API is working!"
  });
});

// Fetch menu
app.get("/api/menu", async (req, res) => {
  try {
    const results = await query(
      "SELECT * FROM menu_items WHERE is_available = 1 ORDER BY id ASC"
    );

    res.json(results);
  } catch (error) {
    console.error("Menu query failed:", error.message);

    res.status(500).json({
      message: "Could not load menu."
    });
  }
});

// Pay at Counter
app.post("/api/orders", async (req, res) => {
  const { customer_name, items } = req.body || {};

  if (!validateOrderInput(customer_name, items)) {
    return res.status(400).json({
      message: "Invalid customer name or order items."
    });
  }

  try {
    const { pricedItems, totalPaise } = await getPricedItems(items);

    const orderId = await saveOrder(
      customer_name,
      pricedItems,
      totalPaise,
      "Counter"
    );

    return res.status(201).json({
      success: true,
      message: "Order placed. Please pay at the counter.",
      orderId,
      paymentMethod: "Counter",
      paymentStatus: "Pending",
      totalAmount: (totalPaise / 100).toFixed(2)
    });
  } catch (error) {
    console.error("Counter order failed:", error.message);

    return res.status(400).json({
      message: error.message || "Could not create order."
    });
  }
});

// Create Razorpay order
app.post("/api/payments/create-order", async (req, res) => {
  const { customer_name, items } = req.body || {};

  if (!validateOrderInput(customer_name, items)) {
    return res.status(400).json({
      message: "Invalid customer name or order items."
    });
  }

  let orderId;

  try {
    const razorpay = getRazorpay();
    const { pricedItems, totalPaise } = await getPricedItems(items);

    orderId = await saveOrder(
      customer_name,
      pricedItems,
      totalPaise,
      "Online"
    );

    const razorpayOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: "INR",
      receipt: `sc_${orderId}`,
      notes: {
        canteen_order_id: String(orderId)
      }
    });

    await query(
      "UPDATE orders SET razorpay_order_id = ? WHERE id = ?",
      [razorpayOrder.id, orderId]
    );

    return res.status(201).json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: razorpayOrder.id,
      amount: totalPaise,
      currency: "INR",
      orderId,
      customerName: customer_name.trim()
    });
  } catch (error) {
    console.error("Online order creation failed:", error);

    if (orderId) {
      await query(
        `UPDATE orders
         SET status = 'Cancelled', payment_status = 'Failed'
         WHERE id = ?`,
        [orderId]
      ).catch(() => {});
    }

    return res.status(500).json({
      message: "Could not start online payment. Please try again."
    });
  }
});

// Verify Razorpay payment
app.post("/api/payments/verify", async (req, res) => {
  const {
    orderId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  } = req.body || {};

  if (
    !Number.isSafeInteger(Number(orderId)) ||
    Number(orderId) < 1 ||
    typeof razorpay_order_id !== "string" ||
    typeof razorpay_payment_id !== "string" ||
    typeof razorpay_signature !== "string" ||
    !razorpay_order_id ||
    !razorpay_payment_id ||
    !/^[a-f0-9]{128}$/i.test(razorpay_signature)
  ) {
    return res.status(400).json({
      message: "Invalid payment verification details."
    });
  }

  try {
    const razorpay = getRazorpay();

    const rows = await query(
      `SELECT id, razorpay_order_id, payment_method, payment_status
       FROM orders
       WHERE id = ?
       LIMIT 1`,
      [Number(orderId)]
    );

    if (
      rows.length === 0 ||
      rows[0].payment_method !== "Online" ||
      rows[0].razorpay_order_id !== razorpay_order_id
    ) {
      return res.status(400).json({
        message: "Payment does not match this order."
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest();

    const receivedSignature = Buffer.from(
      razorpay_signature,
      "hex"
    );

    if (
      expectedSignature.length !== receivedSignature.length ||
      !crypto.timingSafeEqual(expectedSignature, receivedSignature)
    ) {
      return res.status(400).json({
        message: "Payment signature verification failed."
      });
    }

    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({
        message: "Payment order mismatch."
      });
    }

    if (payment.status !== "captured") {
      return res.status(409).json({
        message:
          "Payment is not captured yet. Please check the Razorpay payment status."
      });
    }

    await query(
      `UPDATE orders
       SET payment_status = 'Paid', razorpay_payment_id = ?
       WHERE id = ?`,
      [razorpay_payment_id, Number(orderId)]
    );

    return res.json({
      success: true,
      message: "Payment verified successfully.",
      orderId: Number(orderId),
      paymentStatus: "Paid"
    });
  } catch (error) {
    console.error("Payment verification failed:", error);

    return res.status(500).json({
      message: "Could not verify payment. Contact the canteen admin."
    });
  }
});

app.post("/api/students/login", async (req, res) => {
  const { student_id, password } = req.body || {};

  if (
    typeof student_id !== "string" ||
    typeof password !== "string" ||
    !student_id.trim() ||
    !password
  ) {
    return res.status(400).json({
      message: "Enter student ID and password."
    });
  }
  app.post(
  "/api/students/change-password",
  requireStudent,
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 72
    ) {
      return res.status(400).json({
        message: "New password must be between 8 and 72 characters."
      });
    }

    try {
      const results = await query(
        `SELECT id, password_hash, must_change_password
         FROM students
         WHERE id = ?
         LIMIT 1`,
        [req.student.studentId]
      );

      if (results.length === 0) {
        return res.status(404).json({
          message: "Student account not found."
        });
      }

      const student = results[0];

      const matches = await bcrypt.compare(
        currentPassword,
        student.password_hash
      );

      if (!matches) {
        return res.status(401).json({
          message: "Current password is incorrect."
        });
      }

      const newHash = await bcrypt.hash(newPassword, 10);

      await query(
        `UPDATE students
         SET password_hash = ?, must_change_password = FALSE
         WHERE id = ?`,
        [newHash, student.id]
      );

      const token = jwt.sign(
        {
          studentId: student.id,
          student_id: req.student.student_id,
          role: "student",
          mustChangePassword: false
        },
        process.env.JWT_SECRET,
        { expiresIn: "2h" }
      );

      return res.json({
        success: true,
        message: "Password changed successfully.",
        token
      });
    } catch (error) {
      console.error("Student password change failed:", error.message);

      return res.status(500).json({
        message: "Could not change password."
      });
    }
  }
);

  try {
    const results = await query(
      `SELECT id, student_id, password_hash, must_change_password
       FROM students
       WHERE student_id = ?
       LIMIT 1`,
      [student_id.trim().toUpperCase()]
    );

    if (results.length === 0) {
      return res.status(401).json({
        message: "Invalid student ID or password."
      });
    }

    const student = results[0];

    const matches = await bcrypt.compare(
      password,
      student.password_hash
    );

    if (!matches) {
      return res.status(401).json({
        message: "Invalid student ID or password."
      });
    }

    const mustChangePassword = Boolean(
      student.must_change_password
    );

    const token = jwt.sign(
      {
        studentId: student.id,
        student_id: student.student_id,
        role: "student",
        mustChangePassword
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    return res.json({
      success: true,
      message: "Student login successful.",
      token,
      student: {
        student_id: student.student_id,
        mustChangePassword
      }
    });
  } catch (error) {
    console.error("Student login failed:", error.message);

    return res.status(500).json({
      message: "Student login service unavailable."
    });
  }
});

// Admin login
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    !password
  ) {
    return res.status(400).json({
      message: "Enter username and password."
    });
  }

  try {
    const results = await query(
      `SELECT id, username, password_hash
       FROM admins
       WHERE username = ?
       LIMIT 1`,
      [username.trim()]
    );

    if (results.length === 0) {
      return res.status(401).json({
        message: "Invalid username or password."
      });
    }

    const admin = results[0];

    const matches = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!matches) {
      return res.status(401).json({
        message: "Invalid username or password."
      });
    }

    const token = jwt.sign(
      {
        adminId: admin.id,
        username: admin.username,
        role: "admin"
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    return res.json({
      success: true,
      message: "Login successful.",
      token
    });
  } catch (error) {
    console.error("Admin login failed:", error.message);

    return res.status(500).json({
      message: "Login service unavailable."
    });
  }
});

function requireStudent(req, res, next) {
  const authorization = req.headers.authorization || "";
  const parts = authorization.split(" ");

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer" ||
    !parts[1]
  ) {
    return res.status(401).json({
      message: "Please sign in as a student."
    });
  }

  try {
    const decoded = jwt.verify(
      parts[1],
      process.env.JWT_SECRET
    );

    if (
      decoded.role !== "student" ||
      !decoded.studentId
    ) {
      return res.status(403).json({
        message: "Student access required."
      });
    }

    req.student = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      message: "Your session has expired. Please sign in again."
    });
  }
}

// Admin authentication middleware
function requireAdmin(req, res, next) {
  const authorization = req.headers.authorization || "";
  const parts = authorization.split(" ");

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer" ||
    !parts[1]
  ) {
    return res.status(401).json({
      message: "Please sign in as admin."
    });
  }

  try {
    const decoded = jwt.verify(
      parts[1],
      process.env.JWT_SECRET
    );

    if (decoded.role !== "admin" || !decoded.adminId) {
      return res.status(403).json({
        message: "Admin access required."
      });
    }

    req.admin = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      message: "Your session has expired. Please sign in again."
    });
  }
}

// Admin orders dashboard
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const results = await query(`
      SELECT
        o.id,
        o.customer_name,
        o.total_amount,
        o.status,
        o.payment_method,
        o.payment_status,
        o.razorpay_payment_id,
        o.created_at,
        GROUP_CONCAT(
          CONCAT(oi.item_name, ' x ', oi.quantity)
          ORDER BY oi.id
          SEPARATOR ', '
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id
      ORDER BY o.id DESC
    `);

    return res.json(results);
  } catch (error) {
    console.error("Admin orders query failed:", error.message);

    return res.status(500).json({
      message: "Could not load orders."
    });
  }
});

// Update order status
app.patch(
  "/api/admin/orders/:id/status",
  requireAdmin,
  async (req, res) => {
    const orderId = Number(req.params.id);
    const { status } = req.body || {};

    const allowedStatuses = [
      "Pending",
      "Preparing",
      "Ready",
      "Completed",
      "Cancelled"
    ];

    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({
        message: "Invalid order ID."
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid order status."
      });
    }

    try {
      const rows = await query(
        `SELECT payment_method, payment_status
         FROM orders
         WHERE id = ?
         LIMIT 1`,
        [orderId]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          message: "Order not found."
        });
      }

      const order = rows[0];

      if (
        order.payment_method === "Online" &&
        order.payment_status !== "Paid" &&
        status !== "Cancelled"
      ) {
        return res.status(409).json({
          message:
            "This online order cannot be processed until payment is confirmed."
        });
      }

      await query(
        "UPDATE orders SET status = ? WHERE id = ?",
        [status, orderId]
      );

      return res.json({
        success: true,
        message: "Order status updated successfully."
      });
    } catch (error) {
      console.error("Order status update failed:", error.message);

      return res.status(500).json({
        message: "Could not update order status."
      });
    }
  }
);

// Error handler
app.use((err, req, res, next) => {
  console.error("Request processing error:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(400).json({
    message: "Invalid request."
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`QuickBite server running on port ${PORT}`);
});
