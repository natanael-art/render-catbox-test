
const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

app.use(cors());

app.use("/", createProxyMiddleware({
  target: "https://catbox.moe",
  changeOrigin: true,
  followRedirects: true,
  pathRewrite: (path) => path,
  on: {
    proxyRes: (proxyRes) => {
      proxyRes.headers["access-control-allow-origin"] = "*";
    }
  }
}));

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});
