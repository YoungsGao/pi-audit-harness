import express from "express";

const app = express();
const orders = express.Router();

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

orders.get("/:id", (req, res) => {
  res.json({ orderId: req.params.id });
});

app.use("/v3/orders", orders);

app.listen(3000);