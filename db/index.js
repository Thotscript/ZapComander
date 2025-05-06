// db/index.js
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: 'wpptalk_db',    // conecta no seu host local
  port: 3306,           // porta mapeada no docker-compose (3306:3306)
  user: 'wpptalk',
  password: 'wpptalk1234',
  database: 'wpptalk_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export default pool;
