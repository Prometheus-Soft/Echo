import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db';
import { exec } from 'child_process';

const router = express.Router();

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const FRONTEND_REDIRECT_URI = process.env.FRONTEND_URL || 'http://localhost:5173/link-github';

/** Helper wrapper for async/await error handling */
const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
        (req: Request, res: Response, next: NextFunction) =>
            fn(req, res, next).catch(next);

/* =======================
   GITHUB OAUTH ROUTES
======================= */

// STEP 1: Redirect user to GitHub's OAuth dialog
router.get('/github', (req: Request, res: Response) => {
    // Where GitHub will redirect back to
    const backendCallbackUrl = `http://localhost:${process.env.PORT || 5001}/auth/github/callback`;

    // Build GitHub’s authorize URL with your client_id, callback, scopes
    const authorizeUrl =
        `https://github.com/login/oauth/authorize` +
        `?client_id=${CLIENT_ID}` +
        `&redirect_uri=${backendCallbackUrl}` +
        `&scope=repo`; // or other scopes

    console.log(`Redirecting to GitHub: ${authorizeUrl}`);
    return res.redirect(authorizeUrl);
});

// STEP 2: GitHub calls back to /auth/github/callback with "?code=..."
router.get('/github/callback', asyncHandler(async (req: Request, res: Response) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ message: 'GitHub code is missing' });
    }

    // Exchange the code for an access token
    const tokenResponse = await axios.post(
        'https://github.com/login/oauth/access_token',
        { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code },
        { headers: { accept: 'application/json' } }
    );

    const { access_token } = tokenResponse.data;
    console.log('GitHub Access Token:', access_token);

    if (!access_token) {
        return res.status(400).json({ message: 'No access token from GitHub' });
    }

    // (Optional) Use the token to get GitHub user info or store it.
    // For now, we just redirect to the front-end with ?token=...
    return res.redirect(`${FRONTEND_REDIRECT_URI}?token=${access_token}`);
}));

// Example route to fetch user’s repos from GitHub
router.get('/github/repos', asyncHandler(async (req: Request, res: Response) => {
    const bearerToken = req.headers.authorization || '';
    const token = bearerToken.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Missing GitHub access token' });
    }

    const response = await axios.get('https://api.github.com/user/repos', {
        headers: { Authorization: `Bearer ${token}` },
    });
    return res.json(response.data);
}));

// Endpoint to trigger the pipeline
router.post('/trigger-pipeline', asyncHandler(async (req: Request, res: Response) => {
    const { repoUrl, token, user_id } = req.body;
    if (!repoUrl || !token || !user_id) {
        return res.status(400).json({ message: 'Missing repoUrl, token, or user_id' });
    }

    // Set the environment variables for the pipeline
    process.env.GITHUB_REPO_URL = repoUrl;
    process.env.GITHUB_ACCESS_TOKEN = token;
    process.env.USER_ID = user_id;

    // Trigger the pipeline
    exec('dagster pipeline execute -f /app/pipeline/run_pipeline.py -j run_code_analysis_pipeline', (error, stdout, stderr) => {
        if (error) {
            console.error(`Error triggering pipeline: ${error.message}`);
            return res.status(500).json({ message: 'Error triggering pipeline' });
        }
        console.log(`Pipeline output: ${stdout}`);
        res.status(200).json({ message: 'Pipeline triggered successfully' });
    });
}));

/* =======================
   LOCAL AUTH ROUTES
======================= */

// POST /auth/signup
router.post('/signup', asyncHandler(async (req: Request, res: Response) => {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
        return res.status(400).json({ message: 'Missing fields' });
    }

    // Check if email or username in use
    const existing = await pool.query(
        'SELECT * FROM users WHERE email=$1 OR username=$2',
        [email, username]
    );
    if (existing.rows.length > 0) {
        return res.status(400).json({ message: 'Email or username already taken' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert user
    const result = await pool.query(
        `INSERT INTO users (email, username, password)
     VALUES ($1, $2, $3) RETURNING id, username`,
        [email, username, hashedPassword]
    );
    const newUser = result.rows[0];

    // Create JWT
    const token = jwt.sign(
        { id: newUser.id, username: newUser.username },
        JWT_SECRET,
        { expiresIn: '1h' }
    );

    return res.json({ message: 'Sign-up successful!', token, username: newUser.username });
}));

// POST /auth/login
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }

    // find user
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = result.rows[0];
    if (!user) {
        return res.status(401).json({ message: 'Invalid username or password.' });
    }

    // compare password
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        return res.status(401).json({ message: 'Invalid username or password.' });
    }

    // generate JWT
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
        expiresIn: '1h',
    });

    return res.json({ token, username: user.username });
}));

export default router;
