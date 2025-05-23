const express = require('express');
const { ObjectId } = require('mongodb');
const { authenticateToken, getDb } = require('./auth');

const router = express.Router();

// Helper function to get database
const getDatabase = () => {
  const db = getDb();
  if (!db) {
    throw new Error('Database not connected');
  }
  return db;
};

// POST /books - Add a new book (Authenticated users only)
router.post('/books', authenticateToken, async (req, res) => {
  try {
    const { title, author, genre, description, publishedYear } = req.body;

    // Validation
    if (!title || !author || !genre) {
      return res.status(400).json({ 
        error: 'Title, author, and genre are required' 
      });
    }

    const db = getDatabase();

    // Check if book already exists
    const existingBook = await db.collection('books').findOne({
      title: { $regex: new RegExp('^' + title + '$', 'i') },
      author: { $regex: new RegExp('^' + author + '$', 'i') }
    });

    if (existingBook) {
      return res.status(409).json({ 
        error: 'Book with this title and author already exists' 
      });
    }

    // Create new book
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
      message: 'Book added successfully',
      book: {
        id: result.insertedId,
        title,
        author,
        genre,
        description,
        publishedYear,
        averageRating: 0,
        totalReviews: 0
      }
    });

  } catch (error) {
    console.error('Add book error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /books - Get all books with pagination and filters
router.get('/books', async (req, res) => {
  try {
    const db = getDatabase();
    
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Filter parameters
    const { author, genre } = req.query;
    
    // Build filter query
    let filter = {};
    if (author) {
      filter.author = { $regex: author, $options: 'i' };
    }
    if (genre) {
      filter.genre = { $regex: genre, $options: 'i' };
    }

    // Get books with pagination
    const books = await db.collection('books')
      .find(filter)
      .skip(skip)
      .limit(limit)
      .project({
        title: 1,
        author: 1,
        genre: 1,
        description: 1,
        publishedYear: 1,
        averageRating: 1,
        totalReviews: 1,
        createdAt: 1
      })
      .sort({ createdAt: -1 })
      .toArray();

    // Get total count for pagination
    const totalBooks = await db.collection('books').countDocuments(filter);
    const totalPages = Math.ceil(totalBooks / limit);

    res.json({
      books,
      pagination: {
        currentPage: page,
        totalPages,
        totalBooks,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Get books error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /books/:id - Get book details by ID with reviews
router.get('/books/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid book ID' });
    }

    const db = getDatabase();

    // Pagination for reviews
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    // Get book details
    const book = await db.collection('books').findOne({ _id: new ObjectId(id) });

    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // Get reviews with pagination and user details
    const reviews = await db.collection('books').aggregate([
      { $match: { _id: new ObjectId(id) } },
      { $unwind: '$reviews' },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: 'reviews.userId',
          foreignField: '_id',
          as: 'reviewUser'
        }
      },
      {
        $project: {
          'reviews.rating': 1,
          'reviews.comment': 1,
          'reviews.createdAt': 1,
          'reviews.updatedAt': 1,
          'reviews._id': 1,
          'reviewUser.username': 1
        }
      }
    ]).toArray();

    const totalReviews = book.reviews.length;
    const totalPages = Math.ceil(totalReviews / limit);

    res.json({
      book: {
        id: book._id,
        title: book.title,
        author: book.author,
        genre: book.genre,
        description: book.description,
        publishedYear: book.publishedYear,
        averageRating: book.averageRating,
        totalReviews: book.totalReviews,
        createdAt: book.createdAt
      },
      reviews: reviews.map(r => ({
        id: r.reviews._id,
        rating: r.reviews.rating,
        comment: r.reviews.comment,
        username: r.reviewUser[0]?.username || 'Unknown User',
        createdAt: r.reviews.createdAt,
        updatedAt: r.reviews.updatedAt
      })),
      reviewsPagination: {
        currentPage: page,
        totalPages,
        totalReviews,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Get book details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /books/:id/reviews - Submit a review (one per user per book)
router.post('/books/:id/reviews', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid book ID' });
    }

    // Validation
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ 
        error: 'Rating is required and must be between 1 and 5' 
      });
    }

    const db = getDatabase();

    // Check if book exists
    const book = await db.collection('books').findOne({ _id: new ObjectId(id) });
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // Check if user already reviewed this book
    const existingReview = book.reviews.find(
      review => review.userId.toString() === req.user.userId
    );

    if (existingReview) {
      return res.status(409).json({ 
        error: 'You have already reviewed this book' 
      });
    }

    // Create new review
    const newReview = {
      _id: new ObjectId(),
      userId: new ObjectId(req.user.userId),
      rating: parseInt(rating),
      comment: comment || '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Add review to book
    await db.collection('books').updateOne(
      { _id: new ObjectId(id) },
      { 
        $push: { reviews: newReview },
        $inc: { totalReviews: 1 }
      }
    );

    // Recalculate average rating
    const updatedBook = await db.collection('books').findOne({ _id: new ObjectId(id) });
    const totalRating = updatedBook.reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = totalRating / updatedBook.reviews.length;

    await db.collection('books').updateOne(
      { _id: new ObjectId(id) },
      { $set: { averageRating: parseFloat(averageRating.toFixed(1)) } }
    );

    res.status(201).json({
      message: 'Review added successfully',
      review: {
        id: newReview._id,
        rating: newReview.rating,
        comment: newReview.comment,
        username: req.user.username,
        createdAt: newReview.createdAt
      }
    });

  } catch (error) {
    console.error('Add review error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /reviews/:id - Update your own review
router.put('/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    // Validation
    if (rating && (rating < 1 || rating > 5)) {
      return res.status(400).json({ 
        error: 'Rating must be between 1 and 5' 
      });
    }

    const db = getDatabase();

    // Find the book containing this review
    const book = await db.collection('books').findOne({
      'reviews._id': new ObjectId(id)
    });

    if (!book) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Find the specific review
    const review = book.reviews.find(r => r._id.toString() === id);
    
    // Check if user owns this review
    if (review.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'You can only update your own reviews' });
    }

    // Update review
    const updateFields = {};
    if (rating) updateFields['reviews.$.rating'] = parseInt(rating);
    if (comment !== undefined) updateFields['reviews.$.comment'] = comment;
    updateFields['reviews.$.updatedAt'] = new Date();

    await db.collection('books').updateOne(
      { 'reviews._id': new ObjectId(id) },
      { $set: updateFields }
    );

    // Recalculate average rating if rating was updated
    if (rating) {
      const updatedBook = await db.collection('books').findOne({ _id: book._id });
      const totalRating = updatedBook.reviews.reduce((sum, review) => sum + review.rating, 0);
      const averageRating = totalRating / updatedBook.reviews.length;

      await db.collection('books').updateOne(
        { _id: book._id },
        { $set: { averageRating: parseFloat(averageRating.toFixed(1)) } }
      );
    }

    res.json({
      message: 'Review updated successfully',
      review: {
        id: id,
        rating: rating || review.rating,
        comment: comment !== undefined ? comment : review.comment,
        updatedAt: new Date()
      }
    });

  } catch (error) {
    console.error('Update review error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /reviews/:id - Delete your own review
router.delete('/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = getDatabase();

    // Find the book containing this review
    const book = await db.collection('books').findOne({
      'reviews._id': new ObjectId(id)
    });

    if (!book) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Find the specific review
    const review = book.reviews.find(r => r._id.toString() === id);
    
    // Check if user owns this review
    if (review.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'You can only delete your own reviews' });
    }

    // Remove review from book
    await db.collection('books').updateOne(
      { _id: book._id },
      { 
        $pull: { reviews: { _id: new ObjectId(id) } },
        $inc: { totalReviews: -1 }
      }
    );

    // Recalculate average rating
    const updatedBook = await db.collection('books').findOne({ _id: book._id });
    let averageRating = 0;
    
    if (updatedBook.reviews.length > 0) {
      const totalRating = updatedBook.reviews.reduce((sum, review) => sum + review.rating, 0);
      averageRating = parseFloat((totalRating / updatedBook.reviews.length).toFixed(1));
    }

    await db.collection('books').updateOne(
      { _id: book._id },
      { $set: { averageRating } }
    );

    res.json({ message: 'Review deleted successfully' });

  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /search - Search books by title or author
router.get('/search', async (req, res) => {
  try {
    const { q, page = 1, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const db = getDatabase();
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Search by title or author (case-insensitive, partial match)
    const searchQuery = {
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { author: { $regex: q, $options: 'i' } }
      ]
    };

    const books = await db.collection('books')
      .find(searchQuery)
      .skip(skip)
      .limit(parseInt(limit))
      .project({
        title: 1,
        author: 1,
        genre: 1,
        description: 1,
        publishedYear: 1,
        averageRating: 1,
        totalReviews: 1
      })
      .sort({ averageRating: -1, totalReviews: -1 })
      .toArray();

    const totalResults = await db.collection('books').countDocuments(searchQuery);
    const totalPages = Math.ceil(totalResults / parseInt(limit));

    res.json({
      query: q,
      books,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalResults,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1
      }
    });

  } catch (error) {
    console.error('Search books error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;