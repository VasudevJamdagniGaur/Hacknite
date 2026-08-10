const express = require("express");

const authRoutes = require("./auth");
const userRoutes = require("./user");
const analyzeRoutes = require("./analyze");
const checkAiRoutes = require("./checkAi");
const amazonReviewTrustRoutes = require("./amazonReviewTrust");
const amazonReviewScoresRoutes = require("./amazonReviewScores");
const factCheckRoutes = require("./factCheck");
const postsRoutes = require("./posts");
const instagramRoutes = require("./instagram");
const detectVideoRoutes = require("./detectVideo");

const router = express.Router();

router.get("/health", (_req, res) => res.json({ ok: true, service: "veritas-backend" }));

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/analyze", analyzeRoutes);
router.use("/check-ai", checkAiRoutes);
router.use("/amazon-review-trust", amazonReviewTrustRoutes);
router.use("/amazon-review-scores", amazonReviewScoresRoutes);
router.use("/fact-check", factCheckRoutes);
router.use("/posts", postsRoutes);
router.use("/instagram", instagramRoutes);
router.use("/detect-video", detectVideoRoutes);

module.exports = router;

