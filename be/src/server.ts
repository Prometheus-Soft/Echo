// be/src/server.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import authRouter from './auth/authRouter';
import documentsRouter from './routes/documentsRouter';

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({
  origin: 'http://localhost:5173', // Allow only your front-end's origin
  credentials: true,               // Allow credentials (cookies, etc.)
}));

app.use(express.json());

app.use('/auth', authRouter);
app.use('/documents', documentsRouter);

app.get('/', (req, res) => {
  res.send('Hello from the TypeScript backend!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
