import React, { useEffect, useState } from 'react';
import { Box, Drawer, List, ListItem, ListItemText, AppBar, Toolbar, IconButton, Typography, Container, Grid, Paper, Chip, Divider } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import { styled } from '@mui/material/styles';

import Sidebar from './components/Sidebar';
import EventList from './components/EventList';
import ResultDetail from './components/ResultDetail';

import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#6c5ce7' }, // акцентный цвет
    background: { default: '#121212', paper: '#1e1e1e' },
    text: { primary: '#e0e0e0' },
  },
  typography: {
    fontFamily: '"Inter", Roboto, Arial, sans-serif',
  },
});

const drawerWidth = 240;

const API_URL = 'http://localhost:8000';

const App = () => {
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [selectedResult, setSelectedResult] = useState(null);
  const [results, setResults] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchResults = async () => {
      try {
        const res = await fetch(`\${API_URL}/api/health-id/results`);
        if (!res.ok) throw new Error(`HTTP error! status: \${res.status}`);
        const data = await res.json();
        setResults(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchResults();
  }, );


  const mockResults = [
    {
      id: 'res_88b4b361',
      eventId: 'evt_20260915_001',
      workerId: 'wrk_7d2c',
      timestamp: '15 сент. 2026 г., 09:18',
      status: 'green',
      completeness: 100,
      score: 1.00,
      components: [
        { name: 'Физическое состояние', value: 1.00, weight: 0.60 },
        { name: 'Психофизиологическая оценка', value: 1.00, weight: 0.25 },
        { name: 'Контекст осмотров', value: 1.00, weight: 0.15 },
      ],
      details: {
        uncertainty: 0.03,
        modelVersion: 'health_id_v1.0.0',
        metrics: [
          { label: 'ЧСС', value: '72 уд/мин' },
          { label: 'АД систолическое', value: '128 мм рт. ст.' },
          { label: 'АД диастолическое', value: '78 мм рт. ст.' },
          { label: 'Температура', value: '36.6 °C' },
          { label: 'Сатурация', value: '98%' },
          { label: 'Алкогольный тест', value: '0 мг/л' },
        ],
      },
    },
    {
      id: 'res_6b437038',
      eventId: 'evt_20260915_002',
      workerId: 'wrk_a91e',
      timestamp: '15 сент. 2026 г., 08:54',
      status: 'green',
      completeness: 91,
      score: 0.95,
      components: [
        { name: 'Физическое состояние', value: 0.92, weight: 0.60 },
        { name: 'Психофизиологическая оценка', value: 0.98, weight: 0.25 },
        { name: 'Контекст осмотров', value: 1.00, weight: 0.15 },
      ],
      details: {
        uncertainty: 0.05,
        modelVersion: 'health_id_v1.0.0',
        metrics: [
          { label: 'ЧСС', value: '88 уд/мин' },
          { label: 'АД систолическое', value: '138 мм рт. ст.' },
        ],
      },
    },
  ];

  return (
    <ThemeProvider theme={theme}>
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <CssBaseline />
      <AppBar position="static" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={() => setDrawerOpen(!drawerOpen)}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" noWrap component="div" sx={{ ml: 2 }}>
            HEALTH_ID
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip label="API подключён" color="success" size="small" />
            <Chip label="Биометрия не хранится" color="default" size="small" />
          </Box>
        </Toolbar>
      </AppBar>

      <Sidebar open={drawerOpen} />

      <Box component="main" sx={{ flexGrow: 1, overflow: 'hidden' }}>
        <Container maxWidth={false} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* Header: Search, filters, actions */}
          <Box sx={{ p: 2, mb: 1, background: '#f5f7fa' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              <Box sx={{ position: 'relative', flexGrow: 1, minWidth: 300 }}>
                <SearchIcon sx={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'text.secondary' }} />
                <Box
                  component="input"
                  type="text"
                  placeholder="Поиск по результату, событию, псевдониму"
                  sx={{
                    width: '100%',
                    padding: '10px 12px 10px 36px',
                    border: '1px solid #ccc',
                    borderRadius: 4,
                    fontSize: 14,
                  }}
                />
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                {['Все сигналы', 'Зелёный', 'Жёлтый', 'Красный'].map((label, idx) => (
                  <Chip
                    key={idx}
                    label={label}
                    size="small"
                    color={label === 'Зелёный' ? 'success' : label === 'Жёлтый' ? 'warning' : label === 'Красный' ? 'error' : 'default'}
                  />
                ))}
              </Box>
              <IconButton size="small" title="Обновить журнал">
                <RefreshIcon />
              </IconButton>
            </Box>
          </Box>

          {/* Main grid: List + Detail */}
          <Grid container spacing={2} sx={{ flexGrow: 1 }}>
            <Grid item xs={12} md={6} lg={5} xl={4} sx={{ display: 'flex', flexDirection: 'column' }}>
              <EventList results={mockResults} onSelect={setSelectedResult} selectedId={selectedResult?.id} />
            </Grid>
            <Grid item xs={12} md={6} lg={7} xl={8} sx={{ display: 'flex', flexDirection: 'column' }}>
              <ResultDetail result={selectedResult} />
            </Grid>
          </Grid>
        </Container>
      </Box>
    </Box>
  </ThemeProvider>
  );
};

export default App;
