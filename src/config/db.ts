import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT),

  options: "-c client_encoding=UTF8",
  //client_encoding: "utf8",
});

pool.on("connect", (client) => {
  client.query("SET client_encoding TO 'UTF8'");
});