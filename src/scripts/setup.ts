import "dotenv/config";
import { startSetupServer } from "../web/setup-server.js";

/**
 * Front de configuração: roda local, sem precisar de nenhuma chave, e grava no .env.
 *   npm run setup   → abra http://localhost:4000
 */
const port = Number(process.env.SETUP_PORT || "4000");
startSetupServer(port);
