<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

const clientApiBase = import.meta.env.VITE_CLIENT_API_BASE || "/api/client";
const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE || "/api/admin";
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const activeView = ref("user");

const clientHealth = ref(null);
const adminHealth = ref(null);
const tickets = ref([]);
const ticketsSource = ref("-");
const adminFiles = ref([]);
const ticketStats = ref({
  open: 0,
  in_progress: 0,
  resolved: 0,
  closed: 0,
});

const busy = ref(false);
const createBusy = ref(false);
const updateBusy = ref(false);
const refreshCacheBusy = ref(false);
const userUploadBusy = ref(false);
const adminUploadBusy = ref(false);
const globalError = ref("");
const successMessage = ref("");

const createForm = ref({
  title: "",
  description: "",
  priority: "medium",
  requesterName: "",
});

const updateForm = ref({
  ticketId: "",
  status: "in_progress",
  assigneeName: "",
});

const userAttachmentForm = ref({
  ticketId: "",
});

const adminAttachmentForm = ref({
  ticketId: "",
});

const userAttachmentFile = ref(null);
const adminAttachmentFile = ref(null);
const userFileInputKey = ref(0);
const adminFileInputKey = ref(0);

function normalizeViewFromPath(pathname) {
  if (pathname.startsWith("/admin")) {
    return "admin";
  }

  return "user";
}

function ensurePathAndView() {
  const pathname = window.location.pathname;
  const view = normalizeViewFromPath(pathname);
  activeView.value = view;

  if (pathname === "/") {
    window.history.replaceState({}, "", "/user");
  }
}

function changeView(view) {
  const targetPath = view === "admin" ? "/admin" : "/user";
  if (window.location.pathname !== targetPath) {
    window.history.pushState({}, "", targetPath);
  }

  activeView.value = view;
  refreshAll();
}

function handlePopState() {
  ensurePathAndView();
  refreshAll();
}

async function requestJson(url, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message = payload.error || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return payload;
}

function statusClass(state) {
  if (state === "up" || state === "ok") {
    return "is-ok";
  }

  if (state === "degraded") {
    return "is-warning";
  }

  return "is-down";
}

function ticketStatusClass(state) {
  if (state === "open") {
    return "chip-open";
  }

  if (state === "in_progress") {
    return "chip-progress";
  }

  if (state === "resolved") {
    return "chip-resolved";
  }

  return "chip-closed";
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

async function loadHealth() {
  const [client, admin] = await Promise.allSettled([
    requestJson(`${clientApiBase}/health`),
    requestJson(`${adminApiBase}/health`),
  ]);

  clientHealth.value = client.status === "fulfilled" ? client.value : { status: "down", dependencies: {} };
  adminHealth.value = admin.status === "fulfilled" ? admin.value : { status: "down", dependencies: {} };
}

async function loadTickets() {
  const data = await requestJson(`${clientApiBase}/tickets`);
  tickets.value = data.tickets || [];
  ticketsSource.value = data.source || "-";
}

async function loadTicketStats() {
  const data = await requestJson(`${adminApiBase}/tickets/stats`);
  ticketStats.value = data.stats || ticketStats.value;
}

async function loadAdminFiles() {
  const data = await requestJson(`${adminApiBase}/files`);
  adminFiles.value = data.files || [];
}

async function refreshAll() {
  busy.value = true;
  globalError.value = "";
  successMessage.value = "";

  try {
    const jobs = [loadTickets()];

    if (activeView.value === "admin") {
      jobs.push(loadHealth(), loadTicketStats(), loadAdminFiles());
    }

    await Promise.all(jobs);
  } catch (error) {
    globalError.value = error.message;
  } finally {
    busy.value = false;
  }
}

async function refreshClientCache() {
  refreshCacheBusy.value = true;
  globalError.value = "";
  successMessage.value = "";

  try {
    await requestJson(`${clientApiBase}/tickets/cache/refresh`, { method: "POST" });
    await loadTickets();
  } catch (error) {
    globalError.value = error.message;
  } finally {
    refreshCacheBusy.value = false;
  }
}

async function createTicket() {
  if (!createForm.value.title || !createForm.value.description || !createForm.value.requesterName) {
    globalError.value = "Renseigne titre, description et demandeur pour creer un ticket.";
    return;
  }

  createBusy.value = true;
  globalError.value = "";
  successMessage.value = "";

  try {
    await requestJson(`${clientApiBase}/tickets`, {
      method: "POST",
      body: JSON.stringify(createForm.value),
    });

    createForm.value = {
      title: "",
      description: "",
      priority: "medium",
      requesterName: "",
    };

    await loadTickets();
    successMessage.value = "Ticket cree avec succes.";
  } catch (error) {
    globalError.value = error.message;
  } finally {
    createBusy.value = false;
  }
}

async function updateTicket() {
  const ticketId = Number.parseInt(updateForm.value.ticketId, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    globalError.value = "Renseigne un identifiant de ticket valide.";
    return;
  }

  updateBusy.value = true;
  globalError.value = "";
  successMessage.value = "";

  try {
    await requestJson(`${adminApiBase}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: updateForm.value.status,
        assigneeName: updateForm.value.assigneeName,
      }),
    });

    await Promise.all([refreshClientCache(), loadTicketStats()]);
    successMessage.value = "Ticket mis a jour avec succes.";
  } catch (error) {
    globalError.value = error.message;
  } finally {
    updateBusy.value = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
      resolve(base64);
    };

    reader.onerror = () => {
      reject(new Error("Impossible de lire le fichier"));
    };

    reader.readAsDataURL(file);
  });
}

function onUserFileSelected(event) {
  userAttachmentFile.value = event.target?.files?.[0] || null;
}

function onAdminFileSelected(event) {
  adminAttachmentFile.value = event.target?.files?.[0] || null;
}

async function uploadAttachment({ apiBase, ticketId, file, rolePrefix }) {
  const contentBase64 = await fileToBase64(file);

  return requestJson(`${apiBase}/tickets/${ticketId}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      contentBase64,
      rolePrefix,
    }),
  });
}

async function uploadUserAttachment() {
  const ticketId = Number.parseInt(userAttachmentForm.value.ticketId, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    globalError.value = "Renseigne un identifiant de ticket valide.";
    return;
  }

  if (!userAttachmentFile.value) {
    globalError.value = "Selectionne un fichier a envoyer.";
    return;
  }

  if (userAttachmentFile.value.size > MAX_FILE_SIZE) {
    globalError.value = "Le fichier depasse 20MB.";
    return;
  }

  userUploadBusy.value = true;
  globalError.value = "";
  successMessage.value = "";

  try {
    await uploadAttachment({
      apiBase: clientApiBase,
      ticketId,
      file: userAttachmentFile.value,
      rolePrefix: "user",
    });

    await loadTickets();
    successMessage.value = "Piece jointe user envoyee avec succes.";
    userAttachmentForm.value.ticketId = "";
    userAttachmentFile.value = null;
    userFileInputKey.value += 1;
  } catch (error) {
    globalError.value = error.message;
  } finally {
    userUploadBusy.value = false;
  }
}

async function uploadAdminAttachment() {
  const ticketId = Number.parseInt(adminAttachmentForm.value.ticketId, 10);

  if (Number.isNaN(ticketId) || ticketId <= 0) {
    globalError.value = "Renseigne un identifiant de ticket valide.";
    return;
  }

  if (!adminAttachmentFile.value) {
    globalError.value = "Selectionne un fichier a envoyer.";
    return;
  }

  if (adminAttachmentFile.value.size > MAX_FILE_SIZE) {
    globalError.value = "Le fichier depasse 20MB.";
    return;
  }

  adminUploadBusy.value = true;
  globalError.value = "";
  successMessage.value = "";

  try {
    await uploadAttachment({
      apiBase: adminApiBase,
      ticketId,
      file: adminAttachmentFile.value,
      rolePrefix: "admin",
    });

    await Promise.all([loadTickets(), loadAdminFiles()]);
    successMessage.value = "Piece jointe admin envoyee avec succes.";
    adminAttachmentForm.value.ticketId = "";
    adminAttachmentFile.value = null;
    adminFileInputKey.value += 1;
  } catch (error) {
    globalError.value = error.message;
  } finally {
    adminUploadBusy.value = false;
  }
}

function downloadTicketAttachment(ticketId) {
  const url = `${clientApiBase}/tickets/${ticketId}/attachments/download`;
  window.open(url, "_blank", "noopener,noreferrer");
}

onMounted(() => {
  ensurePathAndView();
  window.addEventListener("popstate", handlePopState);
  refreshAll();
});

onBeforeUnmount(() => {
  window.removeEventListener("popstate", handlePopState);
});
</script>

<template>
  <main class="page">
    <section class="hero card">
      <p class="eyebrow">TP Kubernetes</p>
      <h1>Plateforme Ticketing Microservices</h1>
      <p>
        Front VueJS, API Client/Admin Express, PostgreSQL, Redis et stockage MinIO.
      </p>
      <div class="role-switch">
        <button class="tab-btn" :class="{ active: activeView === 'user' }" @click="changeView('user')">
          Interface User (/user)
        </button>
        <button class="tab-btn" :class="{ active: activeView === 'admin' }" @click="changeView('admin')">
          Interface Admin (/admin)
        </button>
      </div>
      <div class="button-row">
        <button class="primary" :disabled="busy" @click="refreshAll">
          {{ busy ? "Actualisation..." : "Actualiser" }}
        </button>
        <button :disabled="refreshCacheBusy" @click="refreshClientCache">
          {{ refreshCacheBusy ? "Sync cache..." : "Rafraichir cache tickets" }}
        </button>
      </div>
    </section>

    <section class="grid">
      <article v-if="activeView === 'admin'" class="card">
        <h2>Sante des services</h2>
        <div class="health-list">
          <div class="health-row">
            <span>API Client</span>
            <strong :class="statusClass(clientHealth?.status)">{{ clientHealth?.status || "unknown" }}</strong>
          </div>
          <div class="health-row">
            <span>API Admin</span>
            <strong :class="statusClass(adminHealth?.status)">{{ adminHealth?.status || "unknown" }}</strong>
          </div>
          <div class="health-row">
            <span>PostgreSQL</span>
            <strong :class="statusClass(clientHealth?.dependencies?.postgres)">
              {{ clientHealth?.dependencies?.postgres || "unknown" }}
            </strong>
          </div>
          <div class="health-row">
            <span>Redis</span>
            <strong :class="statusClass(clientHealth?.dependencies?.redis)">
              {{ clientHealth?.dependencies?.redis || "unknown" }}
            </strong>
          </div>
          <div class="health-row">
            <span>MinIO (S3)</span>
            <strong :class="statusClass(clientHealth?.dependencies?.s3)">
              {{ clientHealth?.dependencies?.s3 || "unknown" }}
            </strong>
          </div>
        </div>
      </article>

      <article v-if="activeView === 'admin'" class="card">
        <h2>Statistiques tickets</h2>
        <div class="health-list">
          <div class="health-row"><span>Open</span><strong>{{ ticketStats.open }}</strong></div>
          <div class="health-row"><span>In progress</span><strong>{{ ticketStats.in_progress }}</strong></div>
          <div class="health-row"><span>Resolved</span><strong>{{ ticketStats.resolved }}</strong></div>
          <div class="health-row"><span>Closed</span><strong>{{ ticketStats.closed }}</strong></div>
        </div>
      </article>

      <article class="card card-wide">
        <h2>Tickets</h2>
        <p class="muted">Source actuelle: {{ ticketsSource }}</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Titre</th>
                <th>Description</th>
                <th>Statut</th>
                <th>Priorite</th>
                <th>Demandeur</th>
                <th>Assigne</th>
                <th>Piece jointe</th>
                <th>Maj</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ticket in tickets" :key="ticket.id">
                <td>{{ ticket.id }}</td>
                <td>{{ ticket.title }}</td>
                <td>{{ ticket.description }}</td>
                <td>
                  <span class="status-chip" :class="ticketStatusClass(ticket.status)">
                    {{ ticket.status }}
                  </span>
                </td>
                <td>{{ ticket.priority }}</td>
                <td>{{ ticket.requesterName }}</td>
                <td>{{ ticket.assigneeName || "-" }}</td>
                <td>{{ ticket.attachmentKey || "-" }}</td>
                <td>{{ formatDate(ticket.updatedAt) }}</td>
                <td class="ticket-actions">
                  <button class="small-btn" type="button" :disabled="!ticket.attachmentKey"
                    @click="downloadTicketAttachment(ticket.id)">
                    {{ ticket.attachmentKey ? "Telecharger" : "Aucune PJ" }}
                  </button>
                </td>
              </tr>
              <tr v-if="tickets.length === 0">
                <td colspan="10" class="muted">Aucun ticket disponible.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article v-if="activeView === 'user'" class="card">
        <h2>User: creer un ticket</h2>
        <form class="form" @submit.prevent="createTicket">
          <label>
            Titre
            <input v-model="createForm.title" type="text" placeholder="Ex: Erreur 500 sur login" />
          </label>
          <label>
            Description
            <textarea v-model="createForm.description" rows="4" placeholder="Decris le probleme constate"></textarea>
          </label>
          <label>
            Priorite
            <select v-model="createForm.priority">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            Demandeur
            <input v-model="createForm.requesterName" type="text" placeholder="Nom du demandeur" />
          </label>
          <button class="primary" type="submit" :disabled="createBusy">
            {{ createBusy ? "Creation..." : "Creer le ticket" }}
          </button>
        </form>
      </article>

      <article v-if="activeView === 'user'" class="card">
        <h2>User: envoyer un fichier</h2>
        <form class="form" @submit.prevent="uploadUserAttachment">
          <label>
            Ticket ID
            <input v-model="userAttachmentForm.ticketId" type="number" min="1" placeholder="ID ticket" />
          </label>
          <label>
            Fichier
            <input :key="userFileInputKey" type="file" accept="image/*,application/pdf,.pdf,.txt,.doc,.docx"
              @change="onUserFileSelected" />
          </label>
          <p class="muted-inline">{{ userAttachmentFile ? userAttachmentFile.name : "Aucun fichier selectionne" }}</p>
          <button class="primary" type="submit" :disabled="userUploadBusy">
            {{ userUploadBusy ? "Envoi..." : "Uploader le fichier" }}
          </button>
          <p class="muted">Taille max: 20MB. Upload reeel vers MinIO.</p>
        </form>
      </article>

      <article v-if="activeView === 'admin'" class="card">
        <h2>Admin: maj ticket</h2>
        <form class="form" @submit.prevent="updateTicket">
          <label>
            Ticket ID
            <input v-model="updateForm.ticketId" type="number" min="1" placeholder="ID ticket" />
          </label>
          <label>
            Statut
            <select v-model="updateForm.status">
              <option value="open">open</option>
              <option value="in_progress">in_progress</option>
              <option value="resolved">resolved</option>
              <option value="closed">closed</option>
            </select>
          </label>
          <label>
            Assigne
            <input v-model="updateForm.assigneeName" type="text" placeholder="Nom technicien" />
          </label>
          <button class="primary" type="submit" :disabled="updateBusy">
            {{ updateBusy ? "Mise a jour..." : "Mettre a jour le ticket" }}
          </button>
        </form>
      </article>

      <article v-if="activeView === 'admin'" class="card">
        <h2>Admin: upload fichier ticket</h2>
        <form class="form" @submit.prevent="uploadAdminAttachment">
          <label>
            Ticket ID
            <input v-model="adminAttachmentForm.ticketId" type="number" min="1" placeholder="ID ticket" />
          </label>
          <label>
            Fichier
            <input :key="adminFileInputKey" type="file" accept="image/*,application/pdf,.pdf,.txt,.doc,.docx"
              @change="onAdminFileSelected" />
          </label>
          <p class="muted-inline">{{ adminAttachmentFile ? adminAttachmentFile.name : "Aucun fichier selectionne" }}</p>
          <button class="primary" type="submit" :disabled="adminUploadBusy">
            {{ adminUploadBusy ? "Envoi..." : "Uploader le fichier (admin)" }}
          </button>
          <p class="muted">Taille max: 20MB. Upload via API admin.</p>
        </form>
      </article>

      <article v-if="activeView === 'admin'" class="card">
        <h2>Admin: objets MinIO</h2>
        <ul>
          <li v-for="file in adminFiles" :key="file.key">
            {{ file.key }} ({{ file.size }} bytes)
          </li>
          <li v-if="adminFiles.length === 0" class="muted">Aucun fichier pour le moment.</li>
        </ul>
      </article>
    </section>

    <p v-if="globalError" class="error">{{ globalError }}</p>
    <p v-if="successMessage" class="success">{{ successMessage }}</p>
  </main>
</template>
