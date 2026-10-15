const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));

app.use(express.static(path.join(__dirname, "..", "src")));

app.get("/api/companies", (req, res) => {
  res.json(db.companies);
});

app.listen(PORT, () => {
  console.log(`demo listening on ${PORT}`);
});
