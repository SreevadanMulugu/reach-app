import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StatusBar, Platform, KeyboardAvoidingView, ActivityIndicator,
  Alert, Dimensions, Pressable, Animated, PanResponder, AppState, Linking,
} from 'react-native';

const APP_VERSION = '1.9.5';
// Hosted version manifest — update this URL after publishing each new APK
const VERSION_URL  = 'https://raw.githubusercontent.com/SreevadanMulugu/reach-app/main/version.json';
const APK_DOWNLOAD = 'https://github.com/SreevadanMulugu/reach-app/releases/latest/download/Reach.apk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SplashScreen from 'expo-splash-screen';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as WebBrowser from 'expo-web-browser';
import { useAuthRequest, exchangeCodeAsync, ResponseType, CodeChallengeMethod } from 'expo-auth-session';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

const BG_TASK = 'reach-daily-outreach';

// Background task — actually sends emails automatically, no tap needed
TaskManager.defineTask(BG_TASK, async () => {
  try {
    const authRaw = await AsyncStorage.getItem('reach_auth').catch(() => null);
    const cfgRaw  = await AsyncStorage.getItem('reach_cfg').catch(() => null);
    if (!authRaw || !cfgRaw) return BackgroundFetch.BackgroundFetchResult.NoData;
    const auth = JSON.parse(authRaw);
    const cfg  = JSON.parse(cfgRaw);
    // Weekdays, 9–11am or 2–4pm IST
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = nowIST.getHours(), dow = nowIST.getDay();
    if (dow === 0 || dow === 6) return BackgroundFetch.BackgroundFetchResult.NoData;
    const inWindow = (h >= 9 && h < 11) || (h >= 14 && h < 16);
    if (!inWindow) return BackgroundFetch.BackgroundFetchResult.NoData;
    const db = await import('./src/db');
    const { todaySent } = db.getStats();
    const warmupCap = db.getWarmupCap();
    const limit = Math.min(cfg.dailyLimit || 15, warmupCap);
    if (todaySent >= limit) return BackgroundFetch.BackgroundFetchResult.NoData;

    // Notify: starting
    await Notifications.scheduleNotificationAsync({
      content: { title: 'reach', body: 'Sending your daily emails…', data: {} },
      trigger: null,
    });

    const { refreshAccessToken } = await import('./src/auth');
    let token = await refreshAccessToken(auth);
    if (!token) return BackgroundFetch.BackgroundFetchResult.Failed;

    const { findContacts } = await import('./src/scraper');
    const { generateEmail, callAI } = await import('./src/emailgen');
    const { sendEmail: sendGmail } = await import('./src/gmail');
    const { alreadySent, markSent } = db;

    const aiCall = p => callAI(p, cfg);
    // 9–11am window sends first 8; 2–4pm window sends remaining up to 15
    const windowCap = h < 12 ? 8 : 7;
    const cap = Math.min(windowCap, limit - todaySent);
    if (cap <= 0) return BackgroundFetch.BackgroundFetchResult.NoData;
    let sent = 0;
    const sentEmails = new Set();

    // Use 6 queries in background (fast, ~2 min) instead of foreground's 12
    const contacts = await findContacts(cfg, () => {}, aiCall, 6);
    const fresh = contacts.filter(c => !alreadySent(c.email) && !sentEmails.has(c.email));

    for (const contact of fresh) {
      if (sent >= cap) break;
      try {
        const email = await generateEmail(contact, cfg);
        if (!email) continue;
        const freshAuth = JSON.parse(await AsyncStorage.getItem('reach_auth') || '{}');
        token = await refreshAccessToken(freshAuth) || token;
        await sendGmail(token, { to: contact.email, subject: email.subject, bodyText: email.bodyText, bodyHtml: email.bodyHtml });
        markSent(contact.email, email.subject, contact.name || '', contact.company || contact.domain || '');
        sentEmails.add(contact.email);
        sent++;
      } catch {}
    }

    // Notify: done
    await Notifications.scheduleNotificationAsync({
      content: { title: 'reach', body: sent > 0 ? `Sent ${sent} email${sent !== 1 ? 's' : ''} today ✓` : 'No new contacts found today', data: {} },
      trigger: null,
    });
    return sent > 0 ? BackgroundFetch.BackgroundFetchResult.NewData : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch { return BackgroundFetch.BackgroundFetchResult.Failed; }
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
});

// Android notification channel for daily auto-run alarms
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('autorun', {
    name: 'Daily outreach',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250],
    lightColor: '#0078D4',
  }).catch(() => {});
}

import { GOOGLE_ANDROID_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from './google-config';
import { refreshAccessToken } from './src/auth';
import { findContacts }                from './src/scraper';
import { generateEmail, suggestReply, generateFollowup } from './src/emailgen';
import { sendEmail, getUserEmail, getUnreadMessages, getMessage, markAsRead, decodeBody, getHeader } from './src/gmail';
import { alreadySent, markSent, markReplied, getStats, getWarmupCap, saveReply, getRecentReplies, getDueFollowups, markFollowupSent } from './src/db';

const WARMUP_RAMP = [3, 5, 8, 12, 15];

WebBrowser.maybeCompleteAuthSession();
SplashScreen.preventAutoHideAsync().catch(() => {});

const { width: W, height: H } = Dimensions.get('window');
const SAFE = Platform.OS === 'ios' ? 44 : (StatusBar.currentHeight ?? 0);
const BOTTOM = Platform.OS === 'ios' ? 34 : 16;
const APPBAR = 64; // WP bottom app bar height (above BOTTOM)

// Metro palette
const C = {
  bg:     '#000000',
  panel:  '#0F0F0F',
  edge:   '#1A1A1A',
  wire:   'rgba(255,255,255,0.07)',
  ink:    '#FFFFFF',
  dim:    '#6A6A6A',
  ghost:  '#2E2E2E',
  accent: '#0078D4',
  green:  '#107C10',
  amber:  '#CA5010',
  r: 0,
};

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid', 'profile', 'email',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// Android OAuth — scheme must match the Android OAuth client in Google Cloud Console
const GOOGLE_REDIRECT = 'com.googleusercontent.apps.263005803075-0pirgv5e8ucf0bcvfed7nesc2jn8mbmt:/oauth2redirect';
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

function humanDelay() {
  const ms = 10000 + Math.random() * 15000;
  return new Promise(res => setTimeout(res, Math.round(ms)));
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [ready,     setReady]     = useState(false);
  const [screen,    setScreen]    = useState('home');
  const [auth,      setAuth]      = useState(null);
  const [cfg,       setCfg]       = useState(null);
  const [stats,     setStats]     = useState({ total: 0, todaySent: 0, replies: 0 });
  const [running,   setRunning]   = useState(false);
  const [progress,  setProgress]  = useState({ step: '', sent: 0, total: 0, log: [], sentList: [] });
  const [replies,   setReplies]   = useState([]);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const runningRef = useRef(false);

  const [request, response, promptGoogleAuth] = useAuthRequest({
    clientId:            GOOGLE_ANDROID_CLIENT_ID,
    redirectUri:         GOOGLE_REDIRECT,
    scopes:              GMAIL_SCOPES,
    responseType:        ResponseType.Code,
    usePKCE:             true,
    codeChallengeMethod: CodeChallengeMethod.S256,
    extraParams:         { access_type: 'offline', prompt: 'consent' },
  }, GOOGLE_DISCOVERY);

  useEffect(() => { boot(); }, []);

  // Auto-run when notification is tapped
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(resp => {
      if (resp.notification.request.content.data?.autoRun) {
        // Small delay to let UI settle
        setTimeout(() => runOutreachRef.current?.(), 1500);
      }
    });
    return () => sub.remove();
  }, []);

  const runOutreachRef = useRef(null);
  useEffect(() => { runOutreachRef.current = runOutreach; });

  async function checkForUpdate() {
    try {
      const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return;
      const d = await r.json();
      // Only show banner when GitHub has a NEWER version, not when we're ahead
      if (d.version && d.version.localeCompare(APP_VERSION, undefined, { numeric: true }) > 0) setUpdateAvailable(true);
    } catch {}
  }

  async function boot() {
    const [savedAuth, savedCfg] = await Promise.all([
      AsyncStorage.getItem('reach_auth').then(v => v ? JSON.parse(v) : null).catch(() => null),
      AsyncStorage.getItem('reach_cfg').then(v  => v ? JSON.parse(v) : null).catch(() => null),
    ]);
    checkForUpdate().catch(() => {});
    if (savedAuth) setAuth(savedAuth);
    if (savedCfg)  setCfg(savedCfg);
    refreshStats();
    setReplies(getRecentReplies(30));
    await SplashScreen.hideAsync().catch(() => {});
    setReady(true);
    if (!savedAuth) { setScreen('signin'); return; }
    // If we have auth but no refresh token → user signed in before we had offline access.
    // Show sign-in once more automatically so we get refresh_token. After this, silent forever.
    if (savedAuth && !savedAuth.refreshToken) { setScreen('reauth'); return; }
    if (!savedCfg?.resumeText || !savedCfg?.targetRole) { setScreen('setup'); return; }

    // Register background fetch + schedule exact daily alarm notifications
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status === 'granted') {
        await BackgroundFetch.registerTaskAsync(BG_TASK, {
          minimumInterval: 60 * 60,
          stopOnTerminate: false,
          startOnBoot: true,
        }).catch(() => {});

        // Exact daily alarm at 9:00am IST — auto-launches app and triggers outreach
        // Cancel any existing ones first to avoid duplicates
        await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
        // Schedule 9am and 2pm IST daily (IST = UTC+5:30, so 3:30 UTC and 8:30 UTC)
        for (const [hour, min] of [[3, 30], [8, 30]]) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'reach',
              body: 'Sending your daily emails…',
              data: { autoRun: true },
              android: { channelId: 'autorun' },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DAILY,
              hour,
              minute: min,
            },
          }).catch(() => {});
        }
      }
    } catch {}
  }

  function refreshStats() { setStats(getStats()); }

  async function signIn() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      const result = await promptGoogleAuth();
      if (result?.type !== 'success') return;
      // Exchange auth code for access token
      const tokenResponse = await exchangeCodeAsync({
        clientId:     GOOGLE_ANDROID_CLIENT_ID,
        redirectUri:  GOOGLE_REDIRECT,
        code:         result.params.code,
        extraParams:  { code_verifier: request?.codeVerifier ?? '' },
      }, GOOGLE_DISCOVERY);
      const token = tokenResponse.accessToken;
      if (!token) { Alert.alert('Sign-in failed', 'No access token returned'); return; }
      const email = await getUserEmail(token).catch(() => '');
      const newAuth = {
        accessToken:  token,
        refreshToken: tokenResponse.refreshToken || null,
        expiresAt:    Date.now() + (tokenResponse.expiresIn ?? 3600) * 1000,
        email,
      };
      setAuth(newAuth);
      await AsyncStorage.setItem('reach_auth', JSON.stringify(newAuth));
      setScreen(cfg?.resumeText ? 'home' : 'setup');
    } catch (e) { Alert.alert('Error', e.message); }
  }

  // Auto-refresh Gmail token silently if expired
  async function getFreshToken(currentAuth) {
    const token = await refreshAccessToken(currentAuth);
    // Sync React state if token changed
    if (token && token !== currentAuth?.accessToken) {
      const updated = { ...currentAuth, accessToken: token };
      setAuth(updated);
    }
    return token;
  }

  async function signOut() {
    setAuth(null);
    await AsyncStorage.removeItem('reach_auth');
    setScreen('signin');
  }

  async function saveCfg(newCfg) {
    setCfg(newCfg);
    await AsyncStorage.setItem('reach_cfg', JSON.stringify(newCfg));
  }

  function addLog(msg) {
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    setProgress(p => ({ ...p, log: [`${time}  ${msg}`, ...p.log].slice(0, 60) }));
  }

  async function runOutreach() {
    if (!auth?.accessToken)  { setScreen('signin'); return; }
    if (!cfg?.resumeText)    { setScreen('setup'); return; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});

    // If token expired AND no refresh token → silently re-sign-in (no sign-out needed)
    const tokenExpired = auth.expiresAt && Date.now() > auth.expiresAt - 120000;
    if (tokenExpired && !auth.refreshToken) {
      addLog('Refreshing Google connection…');
      await signIn(); // opens Google once, gets refresh token for the future
      return;
    }

    // Auto-refresh token silently
    const freshToken = await getFreshToken(auth);
    if (freshToken && freshToken !== auth.accessToken) {
      setAuth(a => ({ ...a, accessToken: freshToken }));
    }
    // geminiKey optional — falls back to shared key in emailgen.js

    const { todaySent } = getStats();
    const warmupCap = getWarmupCap();
    const limit = Math.min(cfg.dailyLimit || 15, warmupCap);
    if (todaySent >= limit) {
      const day = WARMUP_RAMP.indexOf(warmupCap) + 1;
      const nextCap = WARMUP_RAMP[Math.min(day, WARMUP_RAMP.length - 1)];
      const msg = warmupCap < 15
        ? `${todaySent} sent today.\n\nAccount warming up (day ${day}/5) — keeps Gmail happy. Tomorrow's limit: ${nextCap}.`
        : `${todaySent} sent today (limit: ${limit})`;
      Alert.alert('Daily limit reached', msg);
      return;
    }

    // Optimal send times: 9–11am and 2–4pm IST
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = nowIST.getHours();
    const inGoodWindow = (h >= 9 && h < 11) || (h >= 14 && h < 16);
    if (!inGoodWindow) {
      const next = h < 9 ? '9am' : h < 14 ? '2pm' : 'tomorrow 9am';
      const go = await new Promise(res =>
        Alert.alert(
          'Not the best time',
          `Cold emails get more replies at 9–11am or 2–4pm IST.\n\nBest next window: ${next}.\n\nSend now anyway?`,
          [{ text: 'Send now', onPress: () => res(true) }, { text: 'Cancel', onPress: () => res(false), style: 'cancel' }]
        )
      );
      if (!go) return;
    }

    setRunning(true);
    runningRef.current = true;
    setProgress({ step: 'Starting…', sent: 0, total: 0, log: [] });
    setScreen('running');

    try {
      const { callAI } = await import('./src/emailgen.js');
      const aiCall = prompt => callAI(prompt, cfg);
      const cap = limit - todaySent;
      let sent = 0;
      let round = 0;
      const sentEmails = new Set();

      // Follow-ups first (3-day and 7-day) — priority over new outreach
      const followupRows = [...getDueFollowups(1), ...getDueFollowups(2)];
      if (followupRows.length) addLog(`${followupRows.length} follow-up${followupRows.length > 1 ? 's' : ''} due — sending first…`);
      for (const row of followupRows) {
        if (!runningRef.current || sent >= cap) break;
        const fNum = row.followup1_at ? 2 : 1;
        addLog(`Follow-up #${fNum} → ${row.company || row.domain}…`);
        try {
          const body = await generateFollowup(row, cfg, fNum);
          if (!body) continue;
          const subject = `Re: ${row.subject}`;
          const token = await getFreshToken(auth);
          await sendEmail(token, { to: row.email, subject, bodyText: body, bodyHtml: `<p>${body.replace(/\n/g,'<br>')}</p>` });
          markFollowupSent(row.email, fNum);
          sent++;
          setProgress(p => ({ ...p, sent, step: `Follow-up sent to ${row.company || row.domain}` }));
          addLog(`✓ Follow-up #${fNum} sent to ${row.company || row.domain}`);
          refreshStats();
          if (sent < cap) await humanDelay();
        } catch (e) { addLog(`Follow-up failed: ${e.message?.slice(0,60)}`); }
      }

      // Loop: keep searching for more companies until quota is filled
      while (runningRef.current && sent < cap) {
        round++;
        addLog(round === 1 ? 'Figuring out who to email…' : `Finding more companies (round ${round})…`);
        const contacts = await findContacts(cfg, msg => {
          setProgress(p => ({ ...p, step: msg }));
          addLog(msg);
        }, aiCall);

        const fresh = contacts.filter(c => !alreadySent(c.email) && !sentEmails.has(c.email));
        if (!fresh.length) {
          if (round === 1) addLog('No new companies found today — try again later');
          else addLog('No more new companies found');
          break;
        }

        addLog(`Found ${contacts.length} companies · ${fresh.length} new`);
        setProgress(p => ({ ...p, total: Math.min(sent + fresh.length, cap), step: 'Writing emails…' }));

        let foundAny = false;
        for (const contact of fresh) {
          if (!runningRef.current) { addLog('Paused'); break; }
          if (sent >= cap) { addLog("Quota filled!"); break; }

          addLog(`Writing email for ${contact.company}…`);
          setProgress(p => ({ ...p, step: `Writing + reviewing email ${sent + 1}…` }));

          const email = await generateEmail(contact, cfg);
          if (!email) { addLog(`Skipped ${contact.company} — couldn't write a good enough email`); continue; }

          addLog(`Quality check: ${email.qualityScore}/10 · sending to ${contact.company}…`);
          try {
            const token = await getFreshToken(auth);
            await sendEmail(token, {
              to: contact.email, subject: email.subject,
              bodyText: email.bodyText, bodyHtml: email.bodyHtml,
            });
            markSent(contact.email, email.subject, contact.name || '', contact.company || contact.domain || '');
            sentEmails.add(contact.email);
            sent++;
            foundAny = true;
            const card = {
              name: contact.name || contact.email.split('@')[0],
              company: contact.company || contact.domain || '',
              score: email.qualityScore,
              email: contact.email,
            };
            setProgress(p => ({ ...p, sent, step: `${sent} sent — adding a human delay…`, sentList: [card, ...p.sentList] }));
            addLog(`✓ Sent to ${contact.company}`);
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            refreshStats();
            if (sent < cap) {
              setProgress(p => ({ ...p, step: 'Waiting a bit before next email…' }));
              await humanDelay();
            }
          } catch (e) {
            addLog(`Couldn't send to ${contact.company}: ${e.message.slice(0,80)}`);
            console.log('[send] error for', contact.email, e.message);
            const isAuthErr = e.message.includes('401') || e.message.includes('invalid_token') ||
              e.message.includes('invalid authentication') || e.message.includes('OAuth');
            if (isAuthErr) {
              addLog('Gmail session expired — reconnecting…');
              setRunning(false); runningRef.current = false;
              refreshStats();
              await signIn(); // re-auth silently — no sign-out needed
              return;
            }
          }
        }

        // Stop if this round found no new contacts at all (web has no more to give)
        if (!fresh.length) break;
      }

      setProgress(p => ({ ...p, step: sent > 0 ? `Done! ${sent} emails sent today` : 'Finished', sent }));
      addLog(sent > 0 ? `All done! Sent ${sent} emails.` : 'Nothing new to send today.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      refreshStats();
    } catch (e) {
      addLog('Something went wrong — please try again');
      setProgress(p => ({ ...p, step: 'Error — try again' }));
    }
    setRunning(false);
    runningRef.current = false;
  }

  function stopRun() {
    runningRef.current = false;
    setRunning(false);
  }

  async function checkReplies() {
    if (!auth?.accessToken) { setScreen('signin'); return; }
    // geminiKey optional — falls back to shared key
    setProgress({ step: 'Checking inbox…', sent: 0, total: 0, log: [] });
    setScreen('running');
    addLog('Reading Gmail inbox…');
    try {
      const messages = await getUnreadMessages(auth.accessToken);
      addLog(`${messages.length} unread messages`);
      let found = 0;
      for (const { id } of messages.slice(0, 20)) {
        const msg     = await getMessage(auth.accessToken, id);
        const from    = getHeader(msg, 'from');
        const subject = getHeader(msg, 'subject');
        const fromEmail = from.match(/<([^>]+)>/)?.[1] || from.trim();
        const fromName  = from.match(/^([^<]+)</)?.[1]?.trim() || fromEmail.split('@')[0];
        const body = decodeBody(msg).replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!body) { await markAsRead(auth.accessToken, id).catch(() => {}); continue; }
        addLog(`Reply from ${fromEmail}…`);
        const suggestion = await suggestReply(fromName, fromEmail.split('@')[1], body, cfg);
        saveReply({ fromEmail, fromName, company: fromEmail.split('@')[1], subject, preview: body.slice(0, 200), suggestedReply: suggestion });
        markReplied(fromEmail);
        await markAsRead(auth.accessToken, id).catch(() => {});
        found++;
      }
      setReplies(getRecentReplies(30));
      setProgress(p => ({ ...p, step: `${found} replies found` }));
      addLog(`Done — ${found} replies`);
      refreshStats();
    } catch (e) { addLog(`Error: ${e.message}`); }
    setRunning(false);
  }

  if (!ready) return <View style={{ flex:1, backgroundColor:C.bg }} />;

  return (
    <View style={{ flex:1, backgroundColor:C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {screen === 'signin'  && <SignInScreen onSignIn={signIn} />}
      {screen === 'reauth'  && <ReauthScreen onSignIn={signIn} />}
      {screen === 'home'    && <HomeScreen auth={auth} cfg={cfg} stats={stats} replies={replies} onRun={runOutreach} onCheckReplies={checkReplies} onSetup={() => setScreen('setup')} onSignOut={signOut} updateAvailable={updateAvailable} />}
      {screen === 'setup'   && <SetupScreen cfg={cfg} onSave={async c => { await saveCfg(c); setScreen('home'); }} onBack={() => setScreen(auth ? 'home' : 'signin')} />}
      {screen === 'running' && <RunningScreen progress={progress} running={running} onStop={stopRun} onDone={() => { setScreen('home'); refreshStats(); }} />}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RE-AUTH  — one-time Google reconnect to get refresh token
// ═══════════════════════════════════════════════════════════════════════════
function ReauthScreen({ onSignIn }) {
  useEffect(() => {
    // Auto-trigger after a brief moment — no tap needed
    const t = setTimeout(() => onSignIn(), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <View style={{ flex:1, justifyContent:'center', alignItems:'center', paddingHorizontal:32 }}>
      <ActivityIndicator color={C.accent} size="large" />
      <Text style={{ color:C.dim, fontSize:14, marginTop:20, textAlign:'center', lineHeight:22 }}>
        Reconnecting Google…{'\n'}one tap and you're set for good.
      </Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGN IN  — WP8.1 panorama: massive type, thin label, blue CTA tile
// ═══════════════════════════════════════════════════════════════════════════
function SignInScreen({ onSignIn }) {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(fade, { toValue:1, duration:600, useNativeDriver:true }).start(); }, []);

  return (
    <Animated.View style={{ flex:1, opacity:fade }}>
      {/* WP panorama: app name small-caps top-left, then large bleed title */}
      <View style={{ flex:1, paddingTop:SAFE+20, paddingLeft:24 }}>
        <Text style={{ color:C.dim, fontSize:12, fontWeight:'600', letterSpacing:2, marginBottom:28 }}>REACH</Text>

        {/* Panoramic title — bleeds right, no right padding */}
        <Text style={{ color:C.ink, fontSize:56, fontWeight:'700', letterSpacing:-2.5, lineHeight:56, marginBottom:28 }}
          numberOfLines={4} adjustsFontSizeToFit={false}>
          {'find\npeople.\nsend\nemails.'}
        </Text>

        {/* Three-point value list — WP bullet style */}
        {[
          'finds the right person at any company',
          'writes a personal email from your resume',
          'sends from your gmail · runs daily',
        ].map((t, i) => (
          <View key={i} style={{ flexDirection:'row', alignItems:'flex-start', marginBottom:12, paddingRight:40 }}>
            <View style={{ width:3, height:3, borderRadius:1.5, backgroundColor:C.accent, marginTop:8, marginRight:12 }} />
            <Text style={{ color:C.dim, fontSize:14, lineHeight:22, flex:1 }}>{t}</Text>
          </View>
        ))}
      </View>

      {/* WP pinned bottom CTA — full bleed accent tile */}
      <Pressable onPress={onSignIn} style={({ pressed }) => ({
        marginHorizontal:0,
        backgroundColor: pressed ? '#006CBF' : C.accent,
        paddingVertical:26, paddingHorizontal:28,
        flexDirection:'row', alignItems:'center', justifyContent:'space-between',
      })}>
        <View>
          <Text style={{ color:'#fff', fontWeight:'700', fontSize:17, letterSpacing:-0.3 }}>sign in with google</Text>
          <Text style={{ color:'rgba(255,255,255,0.6)', fontSize:11, marginTop:3 }}>
            secondary gmail recommended · send + read only
          </Text>
        </View>
        <Text style={{ color:'rgba(255,255,255,0.8)', fontSize:24 }}>›</Text>
      </Pressable>
      <View style={{ height: BOTTOM + 0, backgroundColor: C.accent }} />
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HOME  — WP8.1 Pivot: large lowercase pivot headers + bottom app bar
// ═══════════════════════════════════════════════════════════════════════════
function HomeScreen({ auth, cfg, stats, replies, onRun, onCheckReplies, onSetup, onSignOut, updateAvailable }) {
  const configured = cfg?.resumeText && cfg?.targetRole;
  const pivotRef   = useRef(null);
  const [tab, setTab] = useState(0);

  function switchTab(i) {
    Haptics.selectionAsync().catch(() => {});
    setTab(i);
    pivotRef.current?.scrollTo({ x: i * W, animated: true });
  }

  return (
    <View style={{ flex:1 }}>
      {/* ── WP Pivot header ── */}
      <View style={{ paddingTop:SAFE+10, paddingHorizontal:20 }}>
        {/* App name — thin, small, above pivot tabs */}
        <Text style={{ color:C.dim, fontSize:13, fontWeight:'400', letterSpacing:0.5, marginBottom:6 }}>reach</Text>

        {/* Pivot tabs — large, bold vs light, overflow to right */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginHorizontal:-20, paddingHorizontal:20, overflow:'visible' }}
          contentContainerStyle={{ gap:28, paddingRight:60 }}>
          {['home', 'replies'].map((t, i) => (
            <Pressable key={t} onPress={() => switchTab(i)} style={{ paddingBottom:14 }}>
              <Text style={{
                color: tab===i ? C.ink : C.dim,
                fontSize: 30,
                fontWeight: tab===i ? '700' : '300',
                letterSpacing: -1,
                lineHeight: 34,
              }}>{t}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={{ height:1, backgroundColor:C.wire, marginHorizontal:-20 }} />
      </View>

      {/* Pivot content */}
      <ScrollView ref={pivotRef} horizontal pagingEnabled scrollEnabled={false}
        showsHorizontalScrollIndicator={false} style={{ flex:1 }}>

        {/* ── TAB 0: home ── */}
        <ScrollView style={{ width:W }} contentContainerStyle={{ paddingBottom:APPBAR+BOTTOM+32 }}
          showsVerticalScrollIndicator={false}>

          {/* Update banner */}
          {updateAvailable && (
            <Pressable onPress={() => Linking.openURL(APK_DOWNLOAD).catch(() => {})}
              style={({ pressed }) => ({
                marginHorizontal:20, marginTop:12, marginBottom:4,
                borderLeftWidth:3, borderLeftColor:C.accent,
                paddingLeft:14, paddingVertical:10,
                backgroundColor: pressed ? C.edge : 'transparent',
              })}>
              <Text style={{ color:C.accent, fontWeight:'700', fontSize:13 }}>update available</Text>
              <Text style={{ color:C.dim, fontSize:11, marginTop:2 }}>tap to download the latest version</Text>
            </Pressable>
          )}

          {/* Live tiles row — square WP-style */}
          {(() => {
            const wCap = getWarmupCap();
            const dayIdx = WARMUP_RAMP.indexOf(wCap);
            const isWarming = wCap < 15;
            const nextCap = WARMUP_RAMP[Math.min(dayIdx + 1, WARMUP_RAMP.length - 1)];
            return (
              <>
                <View style={{ flexDirection:'row', padding:20, gap:6 }}>
                  <BigTile label="today" value={stats.todaySent} sub={`/${Math.min(cfg?.dailyLimit||15, wCap)}`} tileAccent />
                  <BigTile label="total" value={stats.total} />
                  <BigTile label="replies" value={stats.replies} tileGreen />
                </View>
                {isWarming && (
                  <View style={{
                    marginHorizontal:20, marginBottom:12, marginTop:-8,
                    borderLeftWidth:3, borderLeftColor:C.amber,
                    paddingLeft:14, paddingVertical:10,
                  }}>
                    <Text style={{ color:C.amber, fontWeight:'700', fontSize:12, letterSpacing:0.5 }}>
                      ACCOUNT WARMING · DAY {dayIdx + 1}/5
                    </Text>
                    <Text style={{ color:C.dim, fontSize:11, marginTop:3, lineHeight:17 }}>
                      Sending {wCap} emails today to keep Gmail happy.{'\n'}
                      Tomorrow's limit: {nextCap} → full 15 from day 5.
                    </Text>
                    <View style={{ flexDirection:'row', gap:5, marginTop:8 }}>
                      {WARMUP_RAMP.map((_, i) => (
                        <View key={i} style={{
                          width:20, height:4,
                          backgroundColor: i <= dayIdx ? C.amber : C.edge,
                        }} />
                      ))}
                    </View>
                  </View>
                )}
              </>
            );
          })()}

          {/* New address banner — shown only before first send from this account */}
          {stats.total === 0 && configured && (
            <View style={{
              marginHorizontal:20, marginBottom:12,
              borderLeftWidth:3, borderLeftColor:C.accent,
              paddingLeft:14, paddingVertical:10,
            }}>
              <Text style={{ color:C.accent, fontWeight:'700', fontSize:12, letterSpacing:0.5 }}>
                NEW ADDRESS DETECTED
              </Text>
              <Text style={{ color:C.dim, fontSize:11, marginTop:3, lineHeight:17 }}>
                {auth?.email}{'\n'}
                First 5 days are warmed up gradually (3 → 5 → 8 → 12 → 15/day) so Gmail doesn't flag the account. Tap send to begin.
              </Text>
            </View>
          )}

          {/* Account (shown after first send) */}
          {stats.total > 0 && (
            <Text style={{ color:C.dim, fontSize:11, paddingHorizontal:20, marginBottom:20, letterSpacing:0.2 }}>
              {auth?.email}
            </Text>
          )}

          {/* Setup warning */}
          {!configured && (
            <Pressable onPress={onSetup} style={({ pressed }) => ({
              marginHorizontal:20, marginBottom:16, padding:20,
              backgroundColor:'transparent',
              borderLeftWidth:3, borderLeftColor:C.amber,
              paddingLeft:16,
              opacity:pressed?0.7:1,
            })}>
              <Text style={{ color:C.amber, fontWeight:'600', fontSize:14 }}>setup required</Text>
              <Text style={{ color:C.dim, fontSize:12, marginTop:3 }}>paste resume · set target role</Text>
            </Pressable>
          )}

          {/* Primary action — large WP-style tile */}
          <Pressable onPress={configured ? onRun : onSetup}
            style={({ pressed }) => ({
              marginHorizontal:20, marginBottom:8,
              backgroundColor: configured ? (pressed ? C.accent+'CC' : C.accent) : C.edge,
              padding:28,
            })}>
            <Text style={{ color: configured ? '#fff' : C.dim, fontSize:22, fontWeight:'600', letterSpacing:-0.5 }}>
              {configured ? 'send emails' : 'complete setup'}
            </Text>
            <Text style={{ color: configured ? 'rgba(255,255,255,0.65)' : C.ghost, fontSize:12, marginTop:8, lineHeight:18 }}>
              {configured
                ? `up to ${cfg.dailyLimit||15} emails · finds hiring contacts · no duplicates`
                : 'takes 1 minute'}
            </Text>
          </Pressable>

          {/* Secondary */}
          <Pressable onPress={configured ? onCheckReplies : undefined}
            style={({ pressed }) => ({
              marginHorizontal:20, padding:22,
              borderWidth:1, borderColor:C.wire,
              backgroundColor:pressed ? C.edge : 'transparent',
              opacity:configured?1:0.35,
            })}>
            <Text style={{ color:C.ink, fontSize:16, fontWeight:'600' }}>check replies</Text>
            <Text style={{ color:C.dim, fontSize:12, marginTop:4 }}>AI-suggested responses from your inbox</Text>
          </Pressable>

          {/* How it works */}
          {stats.total === 0 && (
            <View style={{ marginHorizontal:20, marginTop:32 }}>
              <Text style={{ color:C.dim, fontSize:10, fontWeight:'600', letterSpacing:1.5, marginBottom:18 }}>HOW IT WORKS</Text>
              {[
                'Searches DDG + Bing for CHROs, CTOs, founders at your target companies',
                'Gemini reads their website and writes a personal email from your resume',
                'Sends via your Gmail with 10–25 s human delays between each email',
                'Never contacts the same company twice — domain-level deduplication',
              ].map((t, i) => (
                <View key={i} style={{ flexDirection:'row', gap:16, marginBottom:16 }}>
                  <Text style={{ color:C.accent, fontSize:12, fontWeight:'700', width:16, paddingTop:1 }}>
                    {String(i+1).padStart(2,'0')}
                  </Text>
                  <Text style={{ color:C.dim, fontSize:13, flex:1, lineHeight:20 }}>{t}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>

        {/* ── TAB 1: replies ── */}
        <ScrollView style={{ width:W }} contentContainerStyle={{ padding:20, paddingBottom:APPBAR+BOTTOM+32 }}
          showsVerticalScrollIndicator={false}>
          {replies.length === 0 ? (
            <View style={{ paddingTop:60, alignItems:'flex-start' }}>
              <Text style={{ color:C.ghost, fontSize:72, fontWeight:'700', letterSpacing:-3 }}>0</Text>
              <Text style={{ color:C.dim, fontSize:16, marginTop:4 }}>no replies yet</Text>
              <Text style={{ color:C.ghost, fontSize:13, marginTop:6, lineHeight:20 }}>
                send emails first,{'\n'}then check back here
              </Text>
            </View>
          ) : replies.map((r, i) => <ReplyCard key={i} reply={r} />)}
        </ScrollView>
      </ScrollView>

      {/* ── WP8.1 Bottom App Bar ── */}
      <View style={{
        position:'absolute', bottom:0, left:0, right:0,
        height:APPBAR+BOTTOM, paddingBottom:BOTTOM,
        backgroundColor:'rgba(0,0,0,0.93)',
        borderTopWidth:1, borderTopColor:C.wire,
        flexDirection:'row', alignItems:'center',
      }}>
        <WPBarBtn icon="⚙" label="setup" onPress={onSetup} />
        <WPBarBtn icon="⌂" label="home" onPress={() => switchTab(0)} active={tab===0} />
        <WPBarBtn icon="↩" label="replies" onPress={() => switchTab(1)} active={tab===1} />
        <WPBarBtn icon="→" label="sign out" onPress={() =>
          Alert.alert('Sign out?', 'You will need to sign in with Gmail again.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign out', style: 'destructive', onPress: onSignOut },
          ])
        } />
      </View>
    </View>
  );
}

function WPBarBtn({ icon, label, onPress, active }) {
  const col = active ? C.accent : '#888';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      flex:1, alignItems:'center', justifyContent:'center',
      paddingTop:8, opacity:pressed?0.4:1,
    })}>
      <Text style={{ color:col, fontSize:22, lineHeight:26 }}>{icon}</Text>
      <Text style={{ color:col, fontSize:9, fontWeight:'600', letterSpacing:1, marginTop:3 }}>
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

function BigTile({ label, value, sub, tileAccent, tileGreen }) {
  const anim = useRef(new Animated.Value(value)).current;
  const displayed = useRef(value);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    Animated.timing(anim, { toValue:value, duration:400, useNativeDriver:false }).start();
    anim.addListener(({ value: v }) => {
      const rounded = Math.round(v);
      if (rounded !== displayed.current) { displayed.current = rounded; setShown(rounded); }
    });
    return () => anim.removeAllListeners();
  }, [value]);

  const bg = tileAccent ? C.accent : tileGreen ? C.green : C.panel;
  const fg = (tileAccent || tileGreen) ? '#fff' : C.ink;
  const fgDim = (tileAccent || tileGreen) ? 'rgba(255,255,255,0.65)' : C.dim;

  return (
    <View style={{ flex:1, backgroundColor:bg, aspectRatio:1, padding:12, justifyContent:'flex-end' }}>
      <Text style={{ color:fg, fontSize:34, fontWeight:'700', letterSpacing:-1.5, lineHeight:36 }}>{shown}</Text>
      {sub && <Text style={{ color:fgDim, fontSize:10, marginTop:1 }}>{sub}</Text>}
      <Text style={{ color:fgDim, fontSize:9, fontWeight:'700', letterSpacing:1.5, marginTop:6 }}>{label.toUpperCase()}</Text>
    </View>
  );
}

function ReplyCard({ reply }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(o => !o)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? C.edge : C.panel,
        padding:16, marginBottom:8,
        borderLeftWidth:3, borderLeftColor:C.accent,
      })}>
      <View style={{ flexDirection:'row', justifyContent:'space-between' }}>
        <View style={{ flex:1 }}>
          <Text style={{ color:C.ink, fontWeight:'700', fontSize:14 }}>{reply.from_name || reply.from_email}</Text>
          <Text style={{ color:C.dim, fontSize:12, marginTop:2 }}>{reply.company}</Text>
        </View>
        <Text style={{ color:C.ghost, fontSize:18 }}>{open?'−':'+'}</Text>
      </View>
      {open && (
        <View style={{ marginTop:12 }}>
          <Text style={{ color:C.dim, fontSize:13, lineHeight:19 }}>{reply.preview}</Text>
          {reply.suggested_reply ? (
            <View style={{ marginTop:14, borderTopWidth:1, borderTopColor:C.wire, paddingTop:14 }}>
              <Text style={{ color:C.accent, fontSize:10, fontWeight:'700', letterSpacing:1, marginBottom:8 }}>SUGGESTED REPLY</Text>
              <Text style={{ color:C.ink, fontSize:13, lineHeight:19 }}>{reply.suggested_reply}</Text>
              <Pressable
                onPress={() => {
                  try { require('react-native').Clipboard.setString(reply.suggested_reply); } catch {}
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                  Alert.alert('Copied');
                }}
                style={({ pressed }) => ({ marginTop:12, opacity:pressed?0.6:1 })}>
                <Text style={{ color:C.accent, fontWeight:'700', fontSize:13 }}>COPY REPLY</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

function MetroBtn({ onPress, label }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      backgroundColor: pressed ? C.edge : 'transparent',
      borderWidth:1, borderColor:C.wire,
      paddingHorizontal:12, paddingVertical:6,
    })}>
      <Text style={{ color:C.dim, fontSize:12, fontWeight:'600', letterSpacing:0.5 }}>{label.toUpperCase()}</Text>
    </Pressable>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNING  — WP People Hub: giant counter + sent person cards
// ═══════════════════════════════════════════════════════════════════════════
function SentCard({ card, first }) {
  return (
    <View style={{
      flexDirection:'row', alignItems:'center', paddingVertical:14,
      borderTopWidth: first ? 0 : 1, borderTopColor:C.wire,
    }}>
      <View style={{ flex:1 }}>
        <Text style={{ color:C.ink, fontWeight:'700', fontSize:16, letterSpacing:-0.5 }} numberOfLines={1}>
          {card.company}
        </Text>
        <Text style={{ color:C.dim, fontSize:12, marginTop:3, fontFamily:Platform.OS==='ios'?'Menlo':'monospace' }} numberOfLines={1}>
          {card.email}
        </Text>
      </View>
      <Text style={{ color: card.score >= 8 ? C.green : C.accent, fontSize:22, fontWeight:'700', letterSpacing:-1, marginLeft:16 }}>
        {card.score}
      </Text>
    </View>
  );
}

function RunningScreen({ progress, running, onStop, onDone }) {
  const countAnim = useRef(new Animated.Value(0)).current;
  const [displaySent, setDisplaySent] = useState(0);

  useEffect(() => {
    Animated.spring(countAnim, { toValue: progress.sent, speed:14, bounciness:3, useNativeDriver:false }).start();
    countAnim.addListener(({ value }) => setDisplaySent(Math.round(value)));
    return () => countAnim.removeAllListeners();
  }, [progress.sent]);

  const pct = progress.total > 0 ? progress.sent / progress.total : 0;
  const sentList = progress.sentList || [];

  return (
    <View style={{ flex:1 }}>
      <ScrollView style={{ flex:1 }} showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: BOTTOM + 100 }}>

        {/* Hero: WP giant counter */}
        <View style={{ paddingTop:SAFE+16, paddingHorizontal:24 }}>
          <Text style={{ color:C.dim, fontSize:11, fontWeight:'600', letterSpacing:2 }}>
            {running ? 'SENDING' : 'COMPLETE'}
          </Text>
          <View style={{ flexDirection:'row', alignItems:'flex-end', marginTop:4 }}>
            <Text style={{ color:C.accent, fontSize:88, fontWeight:'700', letterSpacing:-4, lineHeight:92 }}>
              {displaySent}
            </Text>
            {progress.total > 0 && (
              <Text style={{ color:C.dim, fontSize:20, fontWeight:'300', marginBottom:14, marginLeft:6 }}>
                /{progress.total}
              </Text>
            )}
          </View>

          {/* Thin Metro progress line */}
          <View style={{ height:2, backgroundColor:C.edge, marginBottom:16 }}>
            <View style={{ height:2, backgroundColor:C.accent, width:`${Math.min(100,pct*100)}%` }} />
          </View>

          {/* Current step */}
          <View style={{ flexDirection:'row', alignItems:'center', gap:10, marginBottom:28 }}>
            {running && <ActivityIndicator color={C.accent} size="small" />}
            <Text style={{ color: running ? C.ink : C.dim, fontSize:13, flex:1, lineHeight:20 }}>
              {progress.step}
            </Text>
          </View>
        </View>

        {/* WP People Hub: sent contacts list */}
        {sentList.length > 0 && (
          <View style={{ paddingHorizontal:24 }}>
            <Text style={{ color:C.dim, fontSize:10, fontWeight:'600', letterSpacing:2, marginBottom:8 }}>
              SENT TO
            </Text>
            {sentList.map((card, i) => <SentCard key={i} card={card} first={i===0} />)}
          </View>
        )}

        {/* Activity log — collapsed by default, monospace */}
        {running && progress.log?.length > 0 && (
          <View style={{ paddingHorizontal:24, marginTop:20 }}>
            <Text style={{ color:C.ghost, fontSize:10, fontWeight:'600', letterSpacing:2, marginBottom:8 }}>
              LOG
            </Text>
            {(progress.log || []).slice(0, 8).map((line, i) => (
              <Text key={i} style={{
                color: i===0 ? C.dim : C.ghost,
                fontSize:10,
                fontFamily:Platform.OS==='ios'?'Menlo':'monospace',
                lineHeight:16,
              }}>{line}</Text>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Control — pinned bottom */}
      <View style={{ paddingHorizontal:24, paddingBottom:BOTTOM+16, paddingTop:12,
        borderTopWidth:1, borderTopColor:C.wire, backgroundColor:C.bg }}>
        {running ? (
          <Pressable onPress={onStop} style={({ pressed }) => ({
            borderWidth:1, borderColor:C.wire, padding:18, alignItems:'center', opacity:pressed?0.6:1,
          })}>
            <Text style={{ color:C.dim, fontWeight:'600', fontSize:14, letterSpacing:0.5 }}>STOP</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onDone} style={({ pressed }) => ({
            backgroundColor: pressed ? '#006CBF' : C.accent, padding:20, alignItems:'center',
          })}>
            <Text style={{ color:'#fff', fontWeight:'700', fontSize:15, letterSpacing:0.3 }}>DONE</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP  — wizard: one section at a time, Metro list style
// ═══════════════════════════════════════════════════════════════════════════
function SetupScreen({ cfg, onSave, onBack }) {
  const [name,         setName]         = useState(cfg?.senderName     || '');
  const [geminiKey,    setGeminiKey]    = useState(cfg?.geminiKey      || '');
  const [openAiKey,    setOpenAiKey]    = useState(cfg?.openAiApiKey   || '');
  const [openAiUrl,    setOpenAiUrl]    = useState(cfg?.openAiBaseUrl  || '');
  const [resume,       setResume]       = useState(cfg?.resumeText     || '');
  const [role,         setRole]         = useState(cfg?.targetRole     || '');
  const [cities,       setCities]       = useState((cfg?.targetCities  ||[]).join(', '));
  const [industries,   setIndustries]   = useState((cfg?.targetIndustries||[]).join(', '));
  const [limit,        setLimit]        = useState(String(cfg?.dailyLimit||15));
  const [notes,        setNotes]        = useState(cfg?.additionalNotes || '');

  async function pickFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const name = (asset.name || '').toLowerCase();

      if (name.endsWith('.pdf')) {
        // Extract text from PDF binary
        const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        const text = extractPdfText(b64);
        if (text.length > 50) { setResume(text.slice(0, 5000)); Alert.alert('Resume loaded', `${text.length} characters read from PDF`); }
        else Alert.alert('Scanned PDF', 'This PDF contains images, not text. Please paste your resume text manually.');
        return;
      }

      if (name.match(/\.(docx|doc)$/)) {
        Alert.alert('Word file', 'Open the file in Word or Google Docs, select all, copy, and paste below.');
        return;
      }

      // Plain text / txt / md
      const text = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 }).catch(() => '');
      if (text.trim().length > 50) { setResume(text.trim().slice(0, 5000)); Alert.alert('Loaded', `${text.trim().length} characters imported`); }
      else Alert.alert('File empty', 'Paste your resume text in the box below.');
    } catch { Alert.alert('Import failed', 'Paste your resume text in the box below.'); }
  }

  function extractPdfText(base64) {
    try {
      const bytes = atob(base64);
      const texts = [];
      // Extract text from BT...ET blocks (standard PDF text operators)
      const btEt = /BT\s*([\s\S]*?)\s*ET/g;
      let m;
      while ((m = btEt.exec(bytes)) !== null) {
        const block = m[1];
        // (text) Tj  or  (text) '  patterns
        for (const tm of block.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|')/g)) {
          const t = tm[1].replace(/\\n/g,' ').replace(/\\r/g,'').replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\').trim();
          if (t) texts.push(t);
        }
        // [(text) ...] TJ  pattern
        for (const tm of block.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
          const parts = [...tm[1].matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g)].map(p =>
            p[1].replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\')
          );
          const joined = parts.join('').trim();
          if (joined) texts.push(joined);
        }
      }
      // Fallback: grab any readable ASCII runs (catches some PDFs)
      if (texts.length === 0) {
        const ascii = bytes.replace(/[^\x20-\x7E\n]/g,' ').replace(/\s+/g,' ').trim();
        const words = ascii.match(/[A-Za-z][a-z]{2,}/g) || [];
        if (words.length > 20) return ascii.slice(0, 5000);
      }
      return texts.join(' ').replace(/\s+/g, ' ').slice(0, 5000);
    } catch { return ''; }
  }

  function save() {
    if (!name.trim())   { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); Alert.alert('', 'Enter your first name'); return; }
    if (!resume.trim()) { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); Alert.alert('', 'Paste your resume text'); return; }
    if (!role.trim())   { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); Alert.alert('', 'Enter your target role'); return; }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onSave({
      senderName:       name.trim(),
      geminiKey:        geminiKey.trim(),
      openAiApiKey:     openAiKey.trim(),
      openAiBaseUrl:    openAiUrl.trim() || 'http://localhost:3001/v1',
      resumeText:       resume.trim(),
      targetRole:       role.trim(),
      targetCities:     cities.split(',').map(s=>s.trim()).filter(Boolean),
      targetIndustries: industries.split(',').map(s=>s.trim()).filter(Boolean),
      dailyLimit:       Math.min(20, parseInt(limit)||15),
      additionalNotes:  notes.trim(),
    });
  }

  return (
    <KeyboardAvoidingView style={{ flex:1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
      {/* WP header */}
      <View style={{ paddingTop:SAFE+10, paddingHorizontal:20, paddingBottom:14, borderBottomWidth:1, borderBottomColor:C.wire }}>
        <Pressable onPress={onBack} style={{ marginBottom:8 }}>
          <Text style={{ color:C.accent, fontSize:13, fontWeight:'500', letterSpacing:0.3 }}>‹ back</Text>
        </Pressable>
        <Text style={{ color:C.ink, fontSize:30, fontWeight:'700', letterSpacing:-1 }}>setup</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom:BOTTOM+32 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        <Block label="your name">
          <Row label="First name used to sign emails">
            <LineInput value={name} set={setName} placeholder="Arjun" />
          </Row>
        </Block>

        <Block label="ai key · optional">
          <Text style={{ color:C.dim, fontSize:12, lineHeight:18, paddingHorizontal:20, paddingBottom:12 }}>
            leave blank — free key included (15 emails/day).{'\n'}
            add freellmapi key for unlimited local AI, or gemini key from aistudio.google.com.
          </Text>
          <Row label="FreeLLMAPI / OpenAI-compat key (freellmapi-...)">
            <LineInput value={openAiKey} set={setOpenAiKey} placeholder="freellmapi-xxxx  or  sk-..." secure />
          </Row>
          <Row label="API server URL (your LAN IP if not on same device)">
            <LineInput value={openAiUrl} set={setOpenAiUrl} placeholder="http://192.168.1.x:3001/v1" kb="url" />
          </Row>

          <Row label="Gemini API key (alternative)">
            <LineInput value={geminiKey} set={setGeminiKey} placeholder="leave blank to use shared key" secure />
          </Row>
        </Block>

        <Block label="your resume">
          <Pressable onPress={pickFile} style={({ pressed }) => ({
            marginHorizontal:20, marginBottom:12,
            borderLeftWidth:3, borderLeftColor:C.accent,
            paddingLeft:14, paddingVertical:12,
            opacity:pressed?0.6:1,
          })}>
            <Text style={{ color:C.accent, fontWeight:'600', fontSize:14 }}>import from files</Text>
            <Text style={{ color:C.dim, fontSize:11, marginTop:2 }}>PDF · TXT · paste below</Text>
          </Pressable>
          <TextInput
            value={resume} onChangeText={setResume} multiline
            placeholder="paste resume — skills, experience, projects…"
            placeholderTextColor={C.ghost}
            style={{
              marginHorizontal:20, backgroundColor:C.edge,
              padding:14, color:C.ink, fontSize:13, lineHeight:20,
              minHeight:140, textAlignVertical:'top',
            }}
          />
        </Block>

        <Block label="target job">
          <Row label="Role you're applying for">
            <LineInput value={role} set={setRole} placeholder="Backend Engineer" />
          </Row>
          <Row label="Cities (optional — blank searches all India)">
            <LineInput value={cities} set={setCities} placeholder="Bangalore, Hyderabad, Remote" />
          </Row>
          <Row label="Industries (optional — AI infers from resume)">
            <LineInput value={industries} set={setIndustries} placeholder="fintech, SaaS, product startup" />
          </Row>
          <Row label="Emails per day (max 20)">
            <LineInput value={limit} set={setLimit} placeholder="15" kb="numeric" />
          </Row>
          <Text style={{ color:C.ghost, fontSize:11, paddingHorizontal:20, paddingTop:6, lineHeight:16 }}>
            reaches CHROs · CTOs · founders · never generic mailboxes
          </Text>
        </Block>

        <Block label="additional notes · optional">
          <Text style={{ color:C.dim, fontSize:12, lineHeight:18, paddingHorizontal:20, paddingBottom:12 }}>
            anything you want the ai to know — recent project, why this city, a specific company type you like. woven in naturally.
          </Text>
          <TextInput
            value={notes} onChangeText={setNotes} multiline
            placeholder="e.g. I recently shipped a feature used by 50k users. open to early-stage."
            placeholderTextColor={C.ghost}
            style={{
              marginHorizontal:20, backgroundColor:C.edge,
              padding:14, color:C.ink, fontSize:13, lineHeight:20,
              minHeight:80, textAlignVertical:'top',
            }}
          />
        </Block>

      </ScrollView>

      {/* WP pinned bottom CTA */}
      <View style={{ paddingHorizontal:20, paddingTop:12, paddingBottom:BOTTOM+16, borderTopWidth:1, borderTopColor:C.wire, backgroundColor:C.bg }}>
        <Pressable onPress={save} style={({ pressed }) => ({
          backgroundColor: pressed ? C.accent+'CC' : C.accent,
          padding:20, alignItems:'center',
        })}>
          <Text style={{ color:'#fff', fontWeight:'600', fontSize:15 }}>save &amp; start</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Block({ label, children }) {
  return (
    <View style={{ marginTop:32 }}>
      <Text style={{ color:C.accent, fontSize:10, fontWeight:'700', letterSpacing:2, paddingHorizontal:20, marginBottom:12 }}>
        {label.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, children }) {
  return (
    <View style={{ borderTopWidth:1, borderTopColor:C.wire, paddingHorizontal:20, paddingVertical:16 }}>
      <Text style={{ color:C.dim, fontSize:11, letterSpacing:0.3, marginBottom:10 }}>{label}</Text>
      {children}
    </View>
  );
}

function LineInput({ value, set, placeholder, secure, kb }) {
  return (
    <TextInput
      value={value} onChangeText={set} placeholder={placeholder}
      placeholderTextColor={C.ghost} secureTextEntry={secure}
      keyboardType={kb||'default'} autoCapitalize="none" autoCorrect={false}
      style={{ color:C.ink, fontSize:16, paddingVertical:6, borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.15)' }}
    />
  );
}
