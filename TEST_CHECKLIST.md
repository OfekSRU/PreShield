# Gmail Invite System - Test Checklist

## Pre-Deployment Testing

### Environment Setup
- [ ] Verify Supabase URL is correct
- [ ] Verify Supabase anon key is correct
- [ ] Verify Gmail SMTP credentials are set
- [ ] Verify EMAIL_FROM address is configured

### Code Quality
- [ ] No syntax errors in `api/send-invite-email.js`
- [ ] No syntax errors in updated `preshield.jsx`
- [ ] No syntax errors in updated Supabase function
- [ ] All imports are correct
- [ ] No console errors in browser

## Post-Deployment Testing

### Test 1: API Endpoint Availability
**Steps**:
1. Deploy to Vercel
2. Go to https://vercel.com/ofeksrus-projects/pre-shield/functions
3. Check that `send-invite-email` function is listed

**Expected Result**:
- ✅ Function appears in Vercel Functions list
- ✅ No deployment errors

---

### Test 2: Send Invite Without Error
**Steps**:
1. Open PreShield app
2. Navigate to project settings/invite section
3. Enter a test email address (e.g., test@example.com)
4. Click "Send Invite" button
5. Wait for response

**Expected Result**:
- ✅ No "failed to fetch" error appears
- ✅ Success message displays
- ✅ No console errors (F12 → Console)
- ✅ Network request shows 200 status (F12 → Network)

**If Error Occurs**:
- Check Vercel function logs for errors
- Verify environment variables are set
- Check Supabase function logs
- Verify network connectivity

---

### Test 3: Email Arrives in Inbox
**Steps**:
1. Check email inbox for the test email
2. Open the email
3. Verify sender is correct

**Expected Result**:
- ✅ Email arrives within 2-5 minutes
- ✅ Sender is the configured EMAIL_FROM address
- ✅ Email is not in spam folder

**If Email Doesn't Arrive**:
- Check spam/junk folder
- Verify email address is correct
- Check Supabase function logs for errors
- Verify Gmail SMTP credentials

---

### Test 4: Email Format and Styling
**Steps**:
1. Open the received email
2. Verify HTML rendering
3. Check for:
   - Purple gradient header
   - "You're Invited!" title
   - Project name display
   - "Join Project" button
   - Fallback plain text URL

**Expected Result**:
- ✅ Email displays in HTML format
- ✅ Professional styling is visible
- ✅ All text is readable
- ✅ Button is clickable
- ✅ Colors match PreShield branding (purple #667eea)

**If Styling Missing**:
- Email client may not support HTML
- Try opening in different email client
- Check that Content-Type is set to text/html

---

### Test 5: Gmail Preview Shows URL
**Steps**:
1. Go to Gmail
2. Look at email list (don't open email yet)
3. Hover over email or view preview pane
4. Check what information is displayed

**Expected Result**:
- ✅ Preview shows project name
- ✅ Preview shows project URL
- ✅ Preview shows invitation message
- ✅ Open Graph metadata is being used

**If Preview Missing URL**:
- Gmail may cache old preview (refresh page)
- Try sending a new invite
- Check that og:url meta tag is in HTML
- Verify joinUrl is being populated correctly

---

### Test 6: CTA Button Functionality
**Steps**:
1. Open email in Gmail
2. Look for "Join Project" button
3. Click the button
4. Verify it opens the correct URL

**Expected Result**:
- ✅ Button is visible and styled
- ✅ Button is clickable
- ✅ Clicking opens the project join page
- ✅ URL includes invite token

**If Button Not Working**:
- Check that joinUrl is correct
- Verify invite token is being generated
- Check browser console for errors

---

### Test 7: Project URL Display in Email
**Steps**:
1. Open email
2. Look for the project URL
3. Verify it's correct

**Expected Result**:
- ✅ URL is displayed in email body
- ✅ URL is clickable
- ✅ URL includes invite token
- ✅ URL matches window.location.origin from client

**If URL Missing**:
- Check that origin is being passed from client
- Verify joinUrl is being constructed correctly
- Check Supabase function logs

---

### Test 8: Business Name Display
**Steps**:
1. Send invite with business name
2. Send invite without business name
3. Compare emails

**Expected Result**:
- ✅ With business name: Shows "[Business Name] has invited you..."
- ✅ Without business name: Shows "You have been invited..."
- ✅ Both versions render correctly

---

### Test 9: Multiple Invites
**Steps**:
1. Send invites to multiple email addresses
2. Verify each email arrives
3. Verify each has correct details

**Expected Result**:
- ✅ All emails arrive
- ✅ Each email has correct recipient
- ✅ No cross-contamination of data
- ✅ Each invite token is unique

---

### Test 10: Error Handling
**Steps**:
1. Try sending invite with invalid email
2. Try sending invite with missing fields
3. Check error messages

**Expected Result**:
- ✅ Invalid email shows error message
- ✅ Missing fields show error message
- ✅ Error messages are helpful
- ✅ No generic "failed to fetch" error

---

## Performance Testing

### Test 11: Response Time
**Steps**:
1. Open DevTools (F12)
2. Go to Network tab
3. Send an invite
4. Check request duration

**Expected Result**:
- ✅ Request completes in < 5 seconds
- ✅ Vercel function responds in < 2 seconds
- ✅ No timeouts

---

### Test 12: Concurrent Requests
**Steps**:
1. Send multiple invites simultaneously
2. Verify all complete successfully

**Expected Result**:
- ✅ All requests succeed
- ✅ No rate limiting errors
- ✅ All emails arrive

---

## Rollback Testing

### Test 13: Rollback Procedure
**Steps**:
1. If issues occur, run: `git revert HEAD`
2. Push to GitHub: `git push origin main`
3. Wait for Vercel to redeploy
4. Test that old version works

**Expected Result**:
- ✅ Rollback completes successfully
- ✅ Previous version is deployed
- ✅ System returns to previous state

---

## Sign-Off

| Test | Status | Date | Notes |
|------|--------|------|-------|
| API Endpoint | [ ] | | |
| No Error on Send | [ ] | | |
| Email Arrives | [ ] | | |
| HTML Formatting | [ ] | | |
| Gmail Preview | [ ] | | |
| CTA Button | [ ] | | |
| URL Display | [ ] | | |
| Business Name | [ ] | | |
| Multiple Invites | [ ] | | |
| Error Handling | [ ] | | |
| Response Time | [ ] | | |
| Concurrent Requests | [ ] | | |
| Rollback | [ ] | | |

---

## Notes

- All tests should pass before considering deployment complete
- Document any issues found and their resolutions
- Keep this checklist for future reference
- Update as needed for new features or changes
