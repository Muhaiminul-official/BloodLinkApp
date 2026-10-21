'use strict';

const express = require('express');
const {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');

const PORT = Number(process.env.PORT || 8787);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const ONESIGNAL_APP_ID = "7b905dae-cf70-4e38-a3ff-3ad50af79e73";
const ONESIGNAL_REST_API_KEY = "os_v2_app_poif3lwpobhdri77hlkqv546onwlx3g7nkoukauaqd42swufaptety3wppejpdvs3iik6p4sp2gdrncql3djdlhcky4hckdcylfwlii";
const MAX_NOTIFICATION_IDS = 100;

if (!PROJECT_ID || !ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
  throw new Error(
    'Set FIREBASE_PROJECT_ID, ONESIGNAL_APP_ID, and ONESIGNAL_REST_API_KEY.',
  );
}

if (getApps().length === 0) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credential = serviceAccountJson
    ? cert(JSON.parse(serviceAccountJson))
    : applicationDefault();
  initializeApp({ credential, projectId: PROJECT_ID });
}

const auth = getAuth();
const db = getFirestore();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin is not allowed.' });
  }
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

async function requireFirebaseUser(req, res, next) {
  const authorization = req.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Sign in required.' });

  try {
    const decoded = await auth.verifyIdToken(match[1]);
    if (decoded.email_verified !== true) {
      return res.status(403).json({ error: 'Verified account required.' });
    }
    req.authUser = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired sign-in token.' });
  }
}

async function authorizeNotification(uid, profile, notification) {
  const recipientId = String(notification.userId || '');
  const type = String(notification.type || '');
  const requestId = String(notification.relatedRequestId || '');

  if (!recipientId || !notification.title || !notification.message) return false;
  if (profile.role === 'admin' && type === 'admin_message') return true;

  if (type === 'test') return recipientId === uid;

  if (type === 'request' && requestId) {
    const request = await db.collection('requests').doc(requestId).get();
    return request.exists && request.get('createdById') === uid && recipientId !== uid;
  }

  if (type === 'response' && requestId) {
    const request = await db.collection('requests').doc(requestId).get();
    if (!request.exists || request.get('createdById') !== recipientId) return false;
    const responses = request.get('responses') || [];
    return Array.isArray(responses) && responses.some((response) => response.donorId === uid);
  }

  if (type === 'direct_request' && requestId) {
    const directRequest = await db.collection('direct_requests').doc(requestId).get();
    if (!directRequest.exists) return false;
    const fromUserId = directRequest.get('fromUserId');
    const toUserId = directRequest.get('toUserId');
    const participant = uid === fromUserId || uid === toUserId;
    const otherParticipant = recipientId === fromUserId || recipientId === toUserId;
    return profile.role === 'admin'
      ? otherParticipant
      : participant && otherParticipant && recipientId !== uid;
  }

  return false;
}

function notificationDataForPush(notification) {
  const data = { type: String(notification.type || '') };
  for (const key of ['relatedRequestId', 'relatedDirectRequestId', 'requestId', 'link']) {
    if (notification[key] != null) data[key] = String(notification[key]);
  }
  return data;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/push/notifications', requireFirebaseUser, async (req, res) => {
  const ids = req.body?.notificationIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_NOTIFICATION_IDS) {
    return res.status(400).json({
      error: `notificationIds must contain 1 to ${MAX_NOTIFICATION_IDS} ids.`,
    });
  }
  if (ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(id))) {
    return res.status(400).json({ error: 'A notification id is invalid.' });
  }

  try {
    const uid = req.authUser.uid;
    const profileSnapshot = await db.collection('users').doc(uid).get();
    if (!profileSnapshot.exists) return res.status(403).json({ error: 'Profile not found.' });
    const profile = profileSnapshot.data();
    const uniqueIds = [...new Set(ids)];
    const snapshots = await Promise.all(
      uniqueIds.map((id) => db.collection('notifications').doc(id).get()),
    );
    const authorized = [];
    let alreadySent = 0;
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      const notification = snapshot.data();
      if (await authorizeNotification(uid, profile, notification)) {
        if (notification.pushSentAt) {
          alreadySent += 1;
        } else {
          authorized.push({ id: snapshot.id, notification });
        }
      }
    }

    if (authorized.length + alreadySent !== uniqueIds.length) {
      return res.status(403).json({ error: 'One or more notifications are not authorized.' });
    }

    if (authorized.length === 0) {
      return res.json({ accepted: 0, alreadySent });
    }

    // Group identical messages so one OneSignal request can target many recipient UIDs.
    const groups = new Map();
    for (const item of authorized) {
      const n = item.notification;
      const data = notificationDataForPush(n);
      const key = JSON.stringify([n.title, n.message, data]);
      const group = groups.get(key) || { title: n.title, message: n.message, data, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }

    const results = [];
    for (const group of groups.values()) {
      const recipientIds = [...new Set(group.items.map((item) => String(item.notification.userId)))];
      const response = await fetch('https://api.onesignal.com/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
        },
        body: JSON.stringify({
          app_id: ONESIGNAL_APP_ID,
          target_channel: 'push',
          include_aliases: { external_id: recipientIds },
          headings: { en: String(group.title) },
          contents: { en: String(group.message) },
          data: group.data,
        }),
      });
      const responseBody = await response.text();
      if (!response.ok) {
        console.error('OneSignal rejected push request:', response.status, responseBody);
        return res.status(502).json({ error: 'OneSignal could not accept the push request.' });
      }
      let parsed;
      try { parsed = JSON.parse(responseBody); } catch { parsed = {}; }
      const accepted = Boolean(parsed.id);
      if (accepted) {
        const batch = db.batch();
        for (const item of group.items) {
          batch.update(db.collection('notifications').doc(item.id), {
            pushSentAt: FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
      }
      results.push({ accepted, recipients: recipientIds.length, errors: parsed.errors || [] });
    }

    return res.json({
      accepted: results.reduce((sum, result) => sum + (result.accepted ? result.recipients : 0), 0),
      alreadySent,
      groups: results.length,
      results,
    });
  } catch (error) {
    console.error('Push request failed:', error);
    return res.status(500).json({ error: 'Could not send push notifications.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BloodLink push backend listening on port ${PORT}`);
});
