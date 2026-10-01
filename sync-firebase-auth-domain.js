import fs from 'fs';
import crypto from 'crypto';

function base64Url(str) {
  return Buffer.from(str).toString('base64url');
}

export async function syncAuthorizedDomains(additionalDomain) {
  const saPath = './service-account.json';
  if (!fs.existsSync(saPath)) return;
  try {
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };
    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedClaim = base64Url(JSON.stringify(claimSet));
    const signatureInput = `${encodedHeader}.${encodedClaim}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signatureInput);
    const signature = signer.sign(sa.private_key, 'base64url');
    const jwt = `${signatureInput}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return;

    // Get current config
    const getRes = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${sa.project_id}/config`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!getRes.ok) return;
    const config = await getRes.json();
    const existingDomains = new Set(config.authorizedDomains || []);
    const targetDomains = [
      'localhost',
      'dash-marketing-9302b.firebaseapp.com',
      'dash-marketing-9302b.web.app',
      'dash-de-mkt.vercel.app',
      'run.app',
      'aistudio.google.com',
      'google.com',
      'mktcentral.ai.studio',
      'ai.studio',
      'ais-dev-m2l2w2q52arir6zdftoysv-797675025207.us-east1.run.app',
      'ais-pre-m2l2w2q52arir6zdftoysv-797675025207.us-east1.run.app'
    ];
    if (additionalDomain) {
      targetDomains.push(additionalDomain);
    }
    let changed = false;
    for (const d of targetDomains) {
      if (d && !existingDomains.has(d)) {
        existingDomains.add(d);
        changed = true;
      }
    }
    if (changed) {
      const patchRes = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${sa.project_id}/config?updateMask=authorizedDomains`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          authorizedDomains: Array.from(existingDomains)
        })
      });
      console.log('Firebase authorizedDomains synced. Status:', patchRes.status);
    } else {
      console.log('Firebase authorizedDomains already up to date.');
    }
  } catch (err) {
    console.error('Failed to sync Firebase authorizedDomains:', err.message);
  }
}
