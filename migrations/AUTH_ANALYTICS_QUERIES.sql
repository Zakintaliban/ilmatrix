-- Analytics queries untuk auth_method tracking

-- 1. Count users by authentication method
SELECT 
    auth_method, 
    COUNT(*) as user_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM users 
WHERE is_active = true
GROUP BY auth_method
ORDER BY user_count DESC;

-- 2. New registrations by auth method per month
SELECT 
    DATE_TRUNC('month', created_at) as month,
    auth_method,
    COUNT(*) as new_users
FROM users 
WHERE is_active = true
GROUP BY DATE_TRUNC('month', created_at), auth_method
ORDER BY month DESC, new_users DESC;

-- 3. Last login activity by auth method (active users)
SELECT 
    auth_method,
    COUNT(*) as total_users,
    COUNT(CASE WHEN last_login >= NOW() - INTERVAL '7 days' THEN 1 END) as active_7d,
    COUNT(CASE WHEN last_login >= NOW() - INTERVAL '30 days' THEN 1 END) as active_30d
FROM users 
WHERE is_active = true
GROUP BY auth_method;

-- 4. OAuth vs Email users email verification rates
SELECT 
    auth_method,
    COUNT(*) as total_users,
    COUNT(CASE WHEN email_verified = true THEN 1 END) as verified_users,
    ROUND(COUNT(CASE WHEN email_verified = true THEN 1 END) * 100.0 / COUNT(*), 2) as verification_rate
FROM users 
WHERE is_active = true
GROUP BY auth_method;

-- 5. Find users who might have duplicate accounts (same email, different auth methods)
SELECT 
    email,
    COUNT(*) as account_count,
    STRING_AGG(auth_method, ', ') as auth_methods,
    STRING_AGG(id::text, ', ') as user_ids
FROM users 
WHERE is_active = true
GROUP BY email
HAVING COUNT(*) > 1
ORDER BY account_count DESC;