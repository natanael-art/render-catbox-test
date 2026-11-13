
const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["*"]
}));

app.use("/", createProxyMiddleware({
  target: "https://catbox.moe",
  changeOrigin: true,
  xfwd: true,
  on: {
    proxyReq: (proxyReq, req) => {
      // Não consumir nem reconstruir o multipart body.
    },
    proxyRes: (proxyRes) => {
      proxyRes.headers["access-control-allow-origin"] = "*";
    }
  }
}));

app.listen(process.env.PORT || 10000, "0.0.0.0");
