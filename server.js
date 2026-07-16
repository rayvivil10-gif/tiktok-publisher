require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route d'accueil explicite
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- Config (à définir dans les variables d'environnement, jamais dans le code) ----
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI; // ex: https://ton-projet.glitch.me/callback

// Stockage simple en mémoire (usage personnel, un seul utilisateur)
let session = {
  access_token: null,
  refresh_token: null,
  open_id: null,
  expires_at: null
};

// ---- Étape 1 : lancer la connexion TikTok ----
app.get('/login', (req, res) => {
  const state = Math.random().toString(36).substring(2);
  const scope = 'user.info.basic,video.upload,video.publish';
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${CLIENT_KEY}&scope=${scope}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

// ---- Étape 2 : TikTok redirige ici avec le code ----
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Erreur de connexion TikTok : ${error}`);
  if (!code) return res.send('Aucun code reçu.');

  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    });
    const data = await tokenRes.json();

    if (data.access_token) {
      session.access_token = data.access_token;
      session.refresh_token = data.refresh_token;
      session.open_id = data.open_id;
      session.expires_at = Date.now() + data.expires_in * 1000;
      res.redirect('/?connected=1');
    } else {
      res.send('Erreur lors de l\'échange du token : ' + JSON.stringify(data));
    }
  } catch (err) {
    res.send('Erreur serveur : ' + err.message);
  }
});

// ---- Vérifier l'état de connexion ----
app.get('/status', (req, res) => {
  res.json({ connected: !!session.access_token, open_id: session.open_id });
});

// ---- Étape 3 : uploader une vidéo (mode brouillon OU publication directe) ----
app.post('/upload', upload.single('video'), async (req, res) => {
  if (!session.access_token) {
    return res.status(401).json({ error: 'Non connecté à TikTok. Va sur /login d\'abord.' });
  }
  const filePath = req.file.path;
  const caption = req.body.caption || '';
  const mode = req.body.mode || 'draft';
  const stats = fs.statSync(filePath);
  const videoSize = stats.size;

  const initEndpoint = mode === 'direct'
    ? 'https://open.tiktokapis.com/v2/post/publish/video/init/'
    : 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';

  const initBody = {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1
    }
  };

  // En mode Direct Post, TikTok exige les informations de confidentialité et de déclaration
  if (mode === 'direct') {
    initBody.post_info = {
      title: caption,
      privacy_level: req.body.privacy_level || 'SELF_ONLY',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
      brand_content_toggle: req.body.branded_content === 'true',
      brand_organic_toggle: false
    };
  }

  try {
    const initRes = await fetch(initEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(initBody)
    });
    const initData = await initRes.json();

    if (!initData.data || !initData.data.upload_url) {
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: 'Échec init upload', details: initData });
    }

    const { upload_url, publish_id } = initData.data;

    // 2. Envoyer le fichier vidéo
    const videoBuffer = fs.readFileSync(filePath);
    const putRes = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
        'Content-Type': 'video/mp4'
      },
      body: videoBuffer
    });

    fs.unlinkSync(filePath);

    if (putRes.ok) {
      const message = mode === 'direct'
        ? 'Vidéo publiée directement sur ton compte TikTok.'
        : 'Vidéo envoyée ! Va vérifier ta boîte de réception TikTok pour finaliser la publication.';
      res.json({ success: true, publish_id, message });
    } else {
      res.status(500).json({ error: 'Échec de l\'envoi du fichier', status: putRes.status });
    }
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
