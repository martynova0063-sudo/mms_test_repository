import { Router, type IRouter } from "express";
import healthRouter from "./health";
import healthIdRouter from "./health-id";

const router: IRouter = Router();

router.use(healthRouter);
router.use(healthIdRouter);

export default router;
