const express = require("express");
const { Pool } = require("pg");
const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const fs = require("node:fs/promises");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = Number.parseInt(process.env.PORT || "3002", 10);
const APP_CONFIG_FILE = process.env.APP_CONFIG_FILE || "/app/config/app-config.json";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const POSTGRES_HOST = process.env.POSTGRES_HOST || "localhost";
const POSTGRES_PORT = Number.parseInt(process.env.POSTGRES_PORT || "5432", 10);
const POSTGRES_DB = process.env.POSTGRES_DB || "appdb";
const POSTGRES_USER = process.env.POSTGRES_USER || "appuser";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "apppassword";

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
  service: "back-admin",
  port: PORT,
  features: {},
};

async function loadAppFileConfig() {
  try {
    const raw = await fs.readFile(APP_CONFIG_FILE, "utf8");
    appFileConfig = JSON.parse(raw);
  } catch (error) {
    console.warn("[back-admin] app file config not loaded", error.message);
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

      console.warn(`[back-admin] ${label} failed (attempt ${index}/${attempts})`, error.message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`[back-admin] retry unexpectedly finished for ${label}`);
}

async function checkPostgres() {
  try {
    await pgPool.query("SELECT 1");
    return "up";
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

  return key;
}

app.get("/health", async (_req, res) => {
  const [postgres, s3] = await Promise.all([checkPostgres(), checkS3()]);
  const allUp = [postgres, s3].every((state) => state === "up");

  res.status(allUp ? 200 : 503).json({
    service: "back-admin",
    status: allUp ? "ok" : "degraded",
    dependencies: { postgres, s3 },
  });
});

app.get("/config", (_req, res) => {
  res.json({
    service: "back-admin",
    appConfigFile: appFileConfig,
  });
});

app.get("/tickets", async (_req, res) => {
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

    return res.json({ tickets: result.rows });
  } catch (error) {
    return res.status(500).json({ error: "Unable to list tickets", details: error.message });
  }
});

app.get("/tickets/stats", async (_req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT
        status,
        COUNT(*)::int AS count
      FROM tickets
      GROUP BY status
      ORDER BY status ASC`
    );

    const stats = {
      open: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0,
    };

    for (const row of result.rows) {
      stats[row.status] = row.count;
    }

    return res.json({ stats });
  } catch (error) {
    return res.status(500).json({ error: "Unable to compute stats", details: error.message });
  }
});

app.patch("/tickets/:id", async (req, res) => {
  const ticketId = Number.parseInt(req.params.id, 10);
  const { status, assigneeName } = req.body || {};
  const acceptedStatuses = ["open", "in_progress", "resolved", "closed"];

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: "ticket id is invalid" });
  }

  if (status !== undefined && !acceptedStatuses.includes(status)) {
    return res.status(400).json({ error: "status must be open, in_progress, resolved or closed" });
  }

  if (assigneeName !== undefined && typeof assigneeName !== "string") {
    return res.status(400).json({ error: "assigneeName must be a string" });
  }

  const fields = [];
  const values = [];

  if (status !== undefined) {
    fields.push(`status = $${values.length + 1}`);
    values.push(status);
  }

  if (assigneeName !== undefined) {
    fields.push(`assignee_name = $${values.length + 1}`);
    values.push(assigneeName.trim() || null);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "no fields to update" });
  }

  values.push(ticketId);

  try {
    const result = await pgPool.query(
      `UPDATE tickets
      SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${values.length}
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
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "ticket not found" });
    }

    return res.json({
      message: "ticket updated",
      ticket: result.rows[0],
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to update ticket", details: error.message });
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
      keyPrefix: "admin",
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
  const body = req.body?.content || `admin attachment generated at ${now}`;

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
      keyPrefix: "admin-sample",
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

app.get("/files", async (_req, res) => {
  try {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        MaxKeys: 100,
      })
    );

    const files = (result.Contents || []).map((file) => ({
      key: file.Key,
      size: file.Size,
      lastModified: file.LastModified,
    }));

    return res.json({ bucket: S3_BUCKET, files });
  } catch (error) {
    return res.status(500).json({ error: "Unable to list files", details: error.message });
  }
});

app.post("/files/sample", async (req, res) => {
  const now = new Date().toISOString();
  const key = `admin-sample-${Date.now()}.txt`;
  const body = req.body?.content || `sample generated by back-admin at ${now}`;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: "text/plain",
      })
    );

    return res.status(201).json({
      message: "File uploaded",
      bucket: S3_BUCKET,
      key,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to upload file", details: error.message });
  }
});

async function start() {
  await loadAppFileConfig();
  await retry(() => pgPool.query("SELECT 1"), "postgres connection");
  await ensureTicketsTable();
  await retry(() => ensureBucketExists(), "minio bucket check");

  app.listen(PORT, () => {
    console.log(`[back-admin] listening on ${PORT}`);
  });
}

async function gracefulShutdown() {
  await pgPool.end();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

start().catch((error) => {
  console.error("[back-admin] startup failed", error);
  process.exit(1);
});
