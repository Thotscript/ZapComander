import fs from 'fs';
import tls from 'tls';
import { constants } from 'crypto';

const MAIN_KEY  = '/etc/letsencrypt/live/verbai.com.br/privkey.pem';
const MAIN_CERT = '/etc/letsencrypt/live/verbai.com.br/fullchain.pem';

const DOMAIN_CERTS = {
  'vcard.thebroker.vip': {
    key:  '/etc/letsencrypt/live/vcard.thebroker.vip/privkey.pem',
    cert: '/etc/letsencrypt/live/vcard.thebroker.vip/fullchain.pem'
  },
  'pdf.thebroker.vip': {
    key:  '/etc/letsencrypt/live/pdf.thebroker.vip/privkey.pem',
    cert: '/etc/letsencrypt/live/pdf.thebroker.vip/fullchain.pem'
  }
};

const httpsOptions = {
  key:  fs.readFileSync(MAIN_KEY),
  cert: fs.readFileSync(MAIN_CERT),
  SNICallback: (domain, callback) => {
    const paths = DOMAIN_CERTS[domain];
    let keyPath  = MAIN_KEY;
    let certPath = MAIN_CERT;

    if (paths && fs.existsSync(paths.key) && fs.existsSync(paths.cert)) {
      keyPath  = paths.key;
      certPath = paths.cert;
    }

    try {
      callback(null, tls.createSecureContext({
        key:  fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }));
    } catch (err) {
      console.error(`Erro ao carregar certificado para ${domain}:`, err.message);
      try {
        callback(null, tls.createSecureContext({
          key:  fs.readFileSync(MAIN_KEY),
          cert: fs.readFileSync(MAIN_CERT)
        }));
      } catch (e) { callback(e); }
    }
  },
  secureOptions:
    constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 |
    constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1,
  ciphers: [
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384'
  ].join(':'),
  honorCipherOrder: true
};

export default httpsOptions;
