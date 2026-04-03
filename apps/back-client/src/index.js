const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");
const {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const fs = require("node:fs/promises");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = Number.parseInt(process.env.PORT || "3001", 10);
const APP_CONFIG_FILE = process.env.APP_CONFIG_FILE || "/app/config/app-config.json";
const TICKETS_CACHE_KEY = "tickets:list";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "localhost";
const POSTGRES_PORT = Number.parseInt(process.env.POSTGRES_PORT || "5432", 10);
const POSTGRES_DB = process.env.POSTGRES_DB || "appdb";
const POSTGRES_USER = process.env.POSTGRES_USER || "appuser";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "apppassword";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT || "6379", 10);

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "minio";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "miniopassword";
const S3_BUCKET = process.env.S3_BUCKET || "app-files";

const pgPool = new Pool({
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,
  database: POSTGRES_DB,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
});

const redisClient = createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
});

redisClient.on("error", (error) => {
  console.error("[back-client] redis error", error.message);
});

const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  region: "us-east-1",
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
});

let appFileConfig = {
  service: "back-client",
  port: PORT,
  features: {},
};

async function loadAppFileConfig() {
  try {
    const raw = await fs.readFile(APP_CONFIG_FILE, "utf8");
    appFileConfig = JSON.parse(raw);
  } catch (error) {
    console.warn("[back-client] app file config not loaded", error.message);
  }
}

async function ensureTicketsTable() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
      requester_name TEXT NOT NULL,
      assignee_name TEXT,
      attachment_key TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgPool.query(`
    INSERT INTO tickets (title, description, status, priority, requester_name, assignee_name)
    SELECT seed.title, seed.description, seed.status, seed.priority, seed.requester_name, seed.assignee_name
    FROM (
      VALUES
        ('Connexion VPN instable', 'Le VPN coupe toutes les 10 minutes', 'open', 'high', 'Alice', NULL),
        ('Impossible de reinitialiser mot de passe', 'Le lien de reset renvoie une erreur 500', 'in_progress', 'medium', 'Mehdi', 'Sophie')
    ) AS seed(title, description, status, priority, requester_name, assignee_name)
    WHERE NOT EXISTS (SELECT 1 FROM tickets);
  `);
}

async function ensureBucketExists() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode;
    const missingBucket =
      statusCode === 404 || error?.name === "NotFound" || error?.name === "NoSuchBucket";

    if (missingBucket) {
      await s3Client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      return;
    }

    throw error;
  }
}

async function retry(action, label, attempts = 20, delayMs = 1500) {
  for (let index = 1; index <= attempts; index += 1) {
    try {
      return await action();
    } catch (error) {
      if (index === attempts) {
        throw error;
      }

      console.warn(`[back-client] ${label} failed (attempt ${index}/${attempts})`, error.message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`[back-client] retry unexpectedly finished for ${label}`);
}

async function invalidateTicketsCache() {
  if (redisClient.isOpen) {
    await redisClient.del(TICKETS_CACHE_KEY);
  }
}

async function checkPostgres() {
  try {
    await pgPool.query("SELECT 1");
    return "up";
  } catch {
    return "down";
  }
}

async function checkRedis() {
  try {
    const pong = await redisClient.ping();
    return pong === "PONG" ? "up" : "degraded";
  } catch {
    return "down";
  }
}

async function checkS3() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    return "up";
  } catch {
    return "down";
  }
}

function sanitizeFileName(fileName) {
  const fallback = "attachment.bin";
  if (typeof fileName !== "string" || fileName.trim() === "") {
    return fallback;
  }

  return fileName.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function ensureTicketExists(ticketId) {
  const exists = await pgPool.query("SELECT id FROM tickets WHERE id = $1", [ticketId]);
  return exists.rowCount > 0;
}

async function storeTicketAttachment({ ticketId, body, contentType, fileName, keyPrefix }) {
  const safeFileName = sanitizeFileName(fileName);
  const key = `tickets/${ticketId}/${keyPrefix}-${Date.now()}-${safeFileName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  await pgPool.query(
    "UPDATE tickets SET attachment_key = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
    [key, ticketId]
  );

  await invalidateTicketsCache();

  return key;
}

app.get("/health", async (_req, res) => {
  const [postgres, redis, s3] = await Promise.all([checkPostgres(), checkRedis(), checkS3()]);

  const allUp = [postgres, redis, s3].every((state) => state === "up");
  res.status(allUp ? 200 : 503).json({
    service: "back-client",
    status: allUp ? "ok" : "degraded",
    dependencies: { postgres, redis, s3 },
  });
});

app.get("/config", (_req, res) => {
  res.json({
    service: "back-client",
    appConfigFile: appFileConfig,
  });
});

app.get("/tickets", async (_req, res) => {
  const cacheKey = TICKETS_CACHE_KEY;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return res.json({
        source: "redis",
        tickets: JSON.parse(cached),
      });
    }

    const result = await pgPool.query(
      `SELECT
        id,
        title,
        description,
        status,
        priority,
        requester_name AS "requesterName",
        assignee_name AS "assigneeName",
        attachment_key AS "attachmentKey",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM tickets
      ORDER BY id DESC`
    );

    await redisClient.set(cacheKey, JSON.stringify(result.rows), { EX: 60 });

    return res.json({
      source: "postgres",
      tickets: result.rows,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch tickets", details: error.message });
  }
});

app.get("/tickets/:id", async (req, res) => {
  const ticketId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: "ticket id is invalid" });
  }

  try {
    const result = await pgPool.query(
      `SELECT
        id,
        title,
        description,
        status,
        priority,
        requester_name AS "requesterName",
        assignee_name AS "assigneeName",
        attachment_key AS "attachmentKey",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM tickets
      WHERE id = $1`,
      [ticketId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "ticket not found" });
    }

    return res.json({ ticket: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch ticket", details: error.message });
  }
});

app.post("/tickets", async (req, res) => {
  const { title, description, priority, requesterName } = req.body || {};
  const acceptedPriorities = ["low", "medium", "high"];

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  if (!description || typeof description !== "string") {
    return res.status(400).json({ error: "description is required" });
  }

  if (!requesterName || typeof requesterName !== "string") {
    return res.status(400).json({ error: "requesterName is required" });
  }

  const normalizedPriority = typeof priority === "string" ? priority : "medium";
  if (!acceptedPriorities.includes(normalizedPriority)) {
    return res.status(400).json({ error: "priority must be low, medium or high" });
  }

  try {
    const insertResult = await pgPool.query(
      `INSERT INTO tickets (title, description, priority, requester_name)
      VALUES ($1, $2, $3, $4)
      RETURNING
        id,
        title,
        description,
        status,
        priority,
        requester_name AS "requesterName",
        assignee_name AS "assigneeName",
        attachment_key AS "attachmentKey",
        created_at AS "createdAt",
        updated_at AS "updatedAt"`,
      [title.trim(), description.trim(), normalizedPriority, requesterName.trim()]
    );

    await invalidateTicketsCache();

    return res.status(201).json({
      message: "ticket created",
      ticket: insertResult.rows[0],
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to create ticket", details: error.message });
  }
});

app.post("/tickets/cache/refresh", async (_req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT
        id,
        title,
        description,
        status,
        priority,
        requester_name AS "requesterName",
        assignee_name AS "assigneeName",
        attachment_key AS "attachmentKey",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM tickets
      ORDER BY id DESC`
    );

    await redisClient.set(TICKETS_CACHE_KEY, JSON.stringify(result.rows), { EX: 60 });

    return res.json({
      message: "Cache refreshed",
      count: result.rowCount,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to refresh cache", details: error.message });
  }
});

app.get("/tickets/:id/attachments/download", async (req, res) => {
  const ticketId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: "ticket id is invalid" });
  }

  try {
    const ticketResult = await pgPool.query(
      "SELECT attachment_key AS \"attachmentKey\" FROM tickets WHERE id = $1",
      [ticketId]
    );

    if (ticketResult.rowCount === 0) {
      return res.status(404).json({ error: "ticket not found" });
    }

    const attachmentKey = ticketResult.rows[0].attachmentKey;
    if (!attachmentKey) {
      return res.status(404).json({ error: "ticket has no attachment" });
    }

    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: attachmentKey,
      })
    );

    const fileName = attachmentKey.split("/").pop() || `ticket-${ticketId}-attachment.bin`;
    res.setHeader("Content-Type", object.ContentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    if (object.ContentLength !== undefined) {
      res.setHeader("Content-Length", String(object.ContentLength));
    }

    const stream = object.Body;
    if (!stream || typeof stream.pipe !== "function") {
      return res.status(500).json({ error: "attachment stream is unavailable" });
    }

    stream.on("error", (error) => {
      console.error("[back-client] download stream error", error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Unable to stream attachment" });
      }
    });

    stream.pipe(res);
    return undefined;
  } catch (error) {
    return res.status(500).json({ error: "Unable to download ticket attachment", details: error.message });
  }
});

app.post("/tickets/:id/attachments", async (req, res) => {
  const ticketId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: "ticket id is invalid" });
  }

  const { fileName, contentBase64, contentType } = req.body || {};

  if (!contentBase64 || typeof contentBase64 !== "string") {
    return res.status(400).json({ error: "contentBase64 is required" });
  }

  const normalizedBase64 = contentBase64.includes(",")
    ? contentBase64.slice(contentBase64.indexOf(",") + 1)
    : contentBase64;

  let fileBuffer;
  try {
    fileBuffer = Buffer.from(normalizedBase64, "base64");
  } catch {
    return res.status(400).json({ error: "contentBase64 is invalid" });
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "decoded file is empty" });
  }

  if (fileBuffer.length > MAX_ATTACHMENT_BYTES) {
    return res.status(413).json({ error: "file too large (max 20MB)" });
  }

  try {
    const ticketExists = await ensureTicketExists(ticketId);
    if (!ticketExists) {
      return res.status(404).json({ error: "ticket not found" });
    }

    const key = await storeTicketAttachment({
      ticketId,
      body: fileBuffer,
      contentType: typeof contentType === "string" && contentType.trim() !== "" ? contentType : "application/octet-stream",
      fileName,
      keyPrefix: "user",
    });

    return res.status(201).json({
      message: "Ticket attachment uploaded",
      bucket: S3_BUCKET,
      key,
      size: fileBuffer.length,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to upload ticket attachment", details: error.message });
  }
});

app.post("/tickets/:id/attachments/sample", async (req, res) => {
  const ticketId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: "ticket id is invalid" });
  }

  const now = new Date().toISOString();
  const body = req.body?.content || `ticket attachment generated by back-client at ${now}`;

  try {
    const ticketExists = await ensureTicketExists(ticketId);
    if (!ticketExists) {
      return res.status(404).json({ error: "ticket not found" });
    }

    const key = await storeTicketAttachment({
      ticketId,
      body,
      contentType: "text/plain",
      fileName: "sample.txt",
      keyPrefix: "sample",
    });

    return res.status(201).json({
      message: "Ticket attachment uploaded",
      bucket: S3_BUCKET,
      key,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to upload ticket attachment", details: error.message });
  }
});

async function start() {
  await loadAppFileConfig();
  await retry(() => pgPool.query("SELECT 1"), "postgres connection");
  await ensureTicketsTable();
  await retry(() => redisClient.connect(), "redis connection");
  await retry(() => ensureBucketExists(), "minio bucket check");

  app.listen(PORT, () => {
    console.log(`[back-client] listening on ${PORT}`);
  });
}

async function gracefulShutdown() {
  const closeRedis = redisClient.isOpen ? redisClient.quit() : Promise.resolve();
  await Promise.allSettled([closeRedis, pgPool.end()]);
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

start().catch((error) => {
  console.error("[back-client] startup failed", error);
  process.exit(1);
});
