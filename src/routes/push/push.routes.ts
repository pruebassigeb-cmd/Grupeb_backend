// src/routes/push/push.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { suscribirPush, desuscribirPush } from "../../controllers/push/push.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

const router = Router();

const pushLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
router.use(pushLimiter);

router.post("/subscribe", authMiddleware, suscribirPush);
router.post("/unsubscribe", authMiddleware, desuscribirPush);

export default router;
