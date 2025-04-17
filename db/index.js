import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: '127.0.0.1',       // ou o nome do container docker, ex: 'mysql'
    user: 'wpptalk',
    password: 'wpptalk1234',
    database: 'wpptalk_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

export default pool;
