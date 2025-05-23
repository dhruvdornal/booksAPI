const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const cors = require('cors');

const app = express();

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
let db;
MongoClient.connect(process.env.MONGODB_URI)
  .then(client => {
    db = client.db('assignment');
    console.log('Connected to MongoDB');
  })
  .catch(err => console.error('DB Error:', err));

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// ROUTES - All in one file to avoid import issues

// Home
app.get('/', (req, res) => {
  res.json({ message: 'API Working!' });
});

// Signup
app.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const existing = await db.collection('users').findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(409).json({ error: 'User exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.collection('users').insertOne({
      username,
      email,
      password: hashedPassword,
      createdAt: new Date()
    });

    const token = jwt.sign(
      { userId: result.insertedId, username, email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'User created',
      token,
      user: { id: result.insertedId, username, email }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await db.collection('users').findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user._id, username: user.username, email: user.email }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add Book
app.post('/books', auth, async (req, res) => {
  try {
    const { title, author, genre, description, publishedYear } = req.body;
    
    if (!title || !author || !genre) {
      return res.status(400).json({ error: 'Title, author, genre required' });
    }

    const newBook = {
      title,
      author,
      genre,
      description: description || '',
      publishedYear: publishedYear || null,
      addedBy: new ObjectId(req.user.userId),
      createdAt: new Date(),
      reviews: [],
      averageRating: 0,
      totalReviews: 0
    };

    const result = await db.collection('books').insertOne(newBook);
    
    res.status(201).json({
      message: 'Book added',
      book: { id: result.insertedId, ...newBook }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get All Books
app.get('/books', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    let filter = {};
    if (req.query.author) filter.author = { $regex: req.query.author, $options: 'i' };
    if (req.query.genre) filter.genre = { $regex: req.query.genre, $options: 'i' };

    const books = await db.collection('books')
      .find(filter)
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await db.collection('books').countDocuments(filter);

    res.json({
      books,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalBooks: total
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Book by ID
app.get('/books/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const book = await db.collection('books').findOne({ _id: new ObjectId(id) });
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    res.json({ book });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add Review
app.post('/books/:id/reviews', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid book ID' });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }

    const book = await db.collection('books').findOne({ _id: new ObjectId(id) });
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // Check if user already reviewed
    const existingReview = book.reviews.find(r => r.userId.toString() === req.user.userId);
    if (existingReview) {
      return res.status(409).json({ error: 'Already reviewed' });
    }

    const newReview = {
      _id: new ObjectId(),
      userId: new ObjectId(req.user.userId),
      rating: parseInt(rating),
      comment: comment || '',
      createdAt: new Date()
    };

    await db.collection('books').updateOne(
      { _id: new ObjectId(id) },
      { 
        $push: { reviews: newReview },
        $inc: { totalReviews: 1 }
      }
    );

    // Update average rating
    const updatedBook = await db.collection('books').findOne({ _id: new ObjectId(id) });
    const totalRating = updatedBook.reviews.reduce((sum, r) => sum + r.rating, 0);
    const avgRating = totalRating / updatedBook.reviews.length;

    await db.collection('books').updateOne(
      { _id: new ObjectId(id) },
      { $set: { averageRating: parseFloat(avgRating.toFixed(1)) } }
    );

    res.status(201).json({
      message: 'Review added',
      review: newReview
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a review by ID (authenticated)
app.put('/reviews/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { rating, comment } = req.body;

  try {
    const book = await db.collection('books').findOne({ 'reviews._id': new ObjectId(id) });

    if (!book) {
      return res.status(404).json({ message: 'Review not found' });
    }

    const reviewIndex = book.reviews.findIndex(
      (review) => review._id.toString() === id
    );

    if (
      reviewIndex === -1 ||
      book.reviews[reviewIndex].userId.toString() !== req.user.userId
    ) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    // Update review fields
    book.reviews[reviewIndex].rating = rating;
    book.reviews[reviewIndex].comment = comment;
    book.reviews[reviewIndex].updatedAt = new Date();

    // Update the whole reviews array in DB
    await db.collection('books').updateOne(
      { _id: book._id },
      { $set: { reviews: book.reviews } }
    );

    res.json({ message: 'Review updated', book });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Delete review by ID (authenticated)
app.delete('/reviews/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const book = await db.collection('books').findOne({ 'reviews._id': new ObjectId(id) });

    if (!book) {
      return res.status(404).json({ message: 'Review not found' });
    }

    const reviewIndex = book.reviews.findIndex(
      (review) => review._id.toString() === id
    );

    if (
      reviewIndex === -1 ||
      book.reviews[reviewIndex].userId.toString() !== req.user.userId
    ) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    // Remove the review from the array
    book.reviews.splice(reviewIndex, 1);

    // Update the book document in MongoDB
    await db.collection('books').updateOne(
      { _id: book._id },
      { $set: { reviews: book.reviews } }
    );

    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Search Books
app.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const books = await db.collection('books')
      .find({
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { author: { $regex: q, $options: 'i' } }
        ]
      })
      .toArray();

    res.json({ books, query: q });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Test: http://localhost:${PORT}`);
});

module.exports = app;