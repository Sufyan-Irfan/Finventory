function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    req.user = req.session.user;
    next();
  } else {
    req.flash('error', 'Please login first.');
    res.redirect('/login');
  }
}

module.exports = { isAuthenticated };
