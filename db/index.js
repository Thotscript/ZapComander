// db/index.js
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: '127.0.0.1',    // conecta no seu host local
  port: 3306,           // porta mapeada no docker-compose (3306:3306)
  user: 'root',
  password: 'Jurassyqi9090@@',
  database: 'zapbot_prod',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset:  'utf8mb4'
});

export default pool;
