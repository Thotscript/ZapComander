-- ============================================================
-- wpptalk_db — schema completo
-- Ordem: usuarios -> sessoes -> logs_sessao -> filtros
-- ============================================================

CREATE TABLE IF NOT EXISTS usuarios (
  email                  VARCHAR(255) NOT NULL,
  plano                  VARCHAR(50)  NOT NULL DEFAULT 'free',
  limite_minutos_mensal  INT          NOT NULL DEFAULT 0,
  senha_hash             VARCHAR(255) DEFAULT NULL,
  criado_em              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Para tabelas já existentes, execute manualmente:
-- ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_hash VARCHAR(255) DEFAULT NULL;

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessoes (
  numero         VARCHAR(100)  NOT NULL,
  usuario_email  VARCHAR(255)  NOT NULL,
  -- status emitidos pelo wppconnect: CONNECTED, MAIN, DISCONNECTED,
  -- CLOSE, UNPAIRED, CONFLICT, OFFLINE
  status         VARCHAR(50)   NOT NULL DEFAULT 'DISCONNECTED',
  criado_em      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (numero),
  UNIQUE KEY uq_sessao_usuario (numero, usuario_email),
  CONSTRAINT fk_sessoes_usuario
    FOREIGN KEY (usuario_email)
    REFERENCES usuarios (email)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS logs_sessao (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email          VARCHAR(255)    NOT NULL,
  sessao_numero  VARCHAR(100)    NOT NULL,
  ultimo_acesso  DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_log_email_sessao (email, sessao_numero),
  CONSTRAINT fk_logs_sessao_sessao
    FOREIGN KEY (sessao_numero)
    REFERENCES sessoes (numero)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS filtros (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sessao_numero  VARCHAR(100)    NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_filtros_sessao
    FOREIGN KEY (sessao_numero)
    REFERENCES sessoes (numero)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
