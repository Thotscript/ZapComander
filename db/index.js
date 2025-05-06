// db/index.js
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: '127.0.0.1',    // conecta no seu host local
  port: 3307,           // porta mapeada no docker-compose (3306:3306)
  user: 'wpptalk',
  password: 'wpptalk1234',
  database: 'wpptalk_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export default pool;
