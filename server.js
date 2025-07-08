import express from "express";
import basicAuth from "express-basic-auth";
import helmet from "helmet";
import fs from "fs/promises";
import path from "path";
import handlebars from "handlebars";
import { z } from "zod";
import puppeteer from "puppeteer";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

// — util functions (idénticas a las que ya tenías) —
function parseRange(rango) {
  const [startStr, endStr] = rango.split(" al ").map((s) => s.trim());
  const parse = (s) => {
    const parts = s.split("/").map(Number);
    if (parts.length === 3) {
      const [d, m, y] = parts;
      return new Date(y, m - 1, d);
    }
    const [d, m] = parts;
    const now = new Date(),
      year = now.getFullYear();
    const date = new Date(year, m - 1, d);
    if (date < now && now.getMonth() - (m - 1) > 6) date.setFullYear(year + 1);
    return date;
  };
  return { start: parse(startStr), end: parse(endStr) };
}

function calcularNoches(rango) {
  const { start, end } = parseRange(rango);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

function extraerHuespedes(texto) {
  const m = texto.match(/\b[Xx]?\s*(\d+)\b/);
  return m ? +m[1] : 1;
}

function prepareData(data) {
  // 1) Calcula Noches, Huespedes y GananciaNeta por fila
  data.rows.forEach((r) => {
    r.Noches = calcularNoches(r.Fecha);
    r.Huespedes = extraerHuespedes(r.Reserva);
    r.GananciaNeta = Number(r.CobroNeto);
  });

  // 2) Totales globales
  const totalNoches = data.rows.reduce((sum, r) => sum + r.Noches, 0);
  const totalGananciaNeta = data.rows.reduce((sum, r) => sum + r.CobroNeto, 0);
  const totalCobroNeto = data.rows.reduce((sum, r) => sum + r.CobroNeto, 0);

  // 3) Promedio de noches **por reserva**, redondeado
  const promedioNoches =
    data.rows.length > 0 ? Math.round(totalNoches / data.rows.length) : 0;

  return {
    ...data,
    nochesReservadas: totalNoches,
    promedioNoches, // entero: noches promedio por reserva
    gananciaNetaTotal: Number(totalCobroNeto.toFixed(2)),
    // (si tú aún quieres la comisión total)
    ComisionAirbnbTotal: Number(
      data.rows.reduce((s, r) => s + r.ComisionAirbnb, 0).toFixed(2)
    ),
    huespedesRecibidos: data.rows.reduce((s, r) => s + r.Huespedes, 0),
  };
}

// — esquema Zod (sólo validamos, sin transform de Fecha) —
const RowSchema = z.object({
  Reserva: z.string().min(1),
  Fecha: z.string().min(5),
  CobroNeto: z.number().nonnegative(),
  ComisionAirbnb: z.number().nonnegative(),
});

const ReportSchema = z.object({
  fechaReporte: z.string().min(1),
  nombreDueno: z.string().min(1),
  puntuacionAirbnb: z.number().min(0).max(5),
  rows: z.array(RowSchema).min(1),
});

(async () => {
  // precarga template y logo
  const tplHtml = await fs.readFile(
    path.resolve("templates/report.html"),
    "utf8"
  );
  const template = handlebars.compile(tplHtml);
  let logoSvg = "";
  try {
    logoSvg = await fs.readFile(path.resolve("templates/logo.svg"), "utf8");
  } catch {}

  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  process.on("SIGINT", async () => {
    await browser.close();
    process.exit();
  });
  process.on("SIGTERM", async () => {
    await browser.close();
    process.exit();
  });

  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(helmet());
  app.use(basicAuth({ users: { [AUTH_USER]: AUTH_PASS }, challenge: true }));

  // HTML Preview
  app.post("/preview-html", (req, res) => {
    const parsed = ReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid payload", details: parsed.error.format() });
    }
    const data = prepareData(parsed.data);
    const html = template({ ...data, logoSvg });
    res.type("html").send(html);
  });

  // PDF
  app.post("/report", async (req, res, next) => {
    try {
      const parsed = ReportSchema.safeParse(req.body);
      if (!parsed.success) throw { status: 400, errors: parsed.error.format() };

      const data = prepareData(parsed.data);
      const html = template({ ...data, logoSvg });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({ format: "A4", printBackground: true });
      await page.close();

      res.contentType("application/pdf").send(pdf);
    } catch (err) {
      next(err);
    }
  });

  // error handler
  app.use((err, req, res, next) => {
    if (err.status === 400) {
      res.status(400).json({ error: "Invalid payload", details: err.errors });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
})();
