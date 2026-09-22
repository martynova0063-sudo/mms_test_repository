import React from 'react';
import { Box, Typography, Chip, Grid, Paper, Button, IconButton, Divider, LinearProgress, Table, TableBody, TableCell, TableRow } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import RefreshIcon from '@mui/icons-material/Refresh';

const ResultDetail = ({ result }) => {
  if (!result) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa' }}>
        <Typography variant="body1">Выберите событие из списка слева</Typography>
      </Box>
    );
  }

  const getStatusLabel = (status) => status === 'green' ? 'ЗЕЛЁНАЯ' : status === 'yellow' ? 'ЖЁЛТАЯ' : 'КРАСНАЯ';
  const getStatusColor = (status) => status === 'green' ? 'success' : status === 'yellow' ? 'warning' : 'error';

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={600}>
            ВЫБРАННЫЙ РЕЗУЛЬТАТ
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {result.id} • {result.eventId}
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={<SendIcon />}
          sx={{ textTransform: 'none' }}
        >
          Передать на проверку
        </Button>
      </Box>

      <Paper sx={{ p: 3, mb: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h3" fontWeight={700} color="text.primary">
            {result.score.toFixed(2)}
          </Typography>
          <Chip
            label={getStatusLabel(result.status)}
            color={getStatusColor(result.status)}
            size="medium"
            sx={{ fontWeight: 600 }}
          />
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          РЕЗУЛЬТАТ HEALTH_ID: {result.score.toFixed(2)} ({getStatusLabel(result.status)} зона)
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
          {result.components.map((c, idx) => (
            <Box key={idx} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                {c.name}: {c.value.toFixed(2)}, вклад {(c.weight * 100).toFixed(0)}%
              </Typography>
              <LinearProgress
                variant="determinate"
                value={c.value * 100}
                sx={{ height: 4, borderRadius: 2, mr: 0 }}
              />
            </Box>
          ))}
        </Box>

        <Divider sx={{ my: 2 }} />

        <Box sx={{ display: 'flex', gap: 3, mb: 2 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              НЕОПРЕДЕЛЁННОСТЬ
            </Typography>
            <Typography variant="h6" fontWeight={600}>
              {result.details.uncertainty.toFixed(2)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              оценка сигнала
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              ПОЛНОТА
            </Typography>
            <Typography variant="h6" fontWeight={600}>
              {result.completeness}%
            </Typography>
            <Typography variant="caption" color="text.secondary">
              входные данные
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              ВЕРСИЯ МОДЕЛИ
            </Typography>
            <Typography variant="h6" fontWeight={600}>
              {result.details.modelVersion}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              зафиксированная версия
            </Typography>
          </Box>
        </Box>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
          Цепочка атрибуции. Вклады компонентов
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {result.components.map((c, idx) => (
            <Chip
              key={idx}
              label={`${c.name} ${(c.weight * 100).toFixed(0)}%`}
              size="small"
              sx={{ backgroundColor: '#eee' }}
            />
          ))}
        </Box>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
          Физическое состояние
        </Typography>
        <Table size="small">
          <TableBody>
            {result.details.metrics.map((m, idx) => (
              <TableRow key={idx}>
                <TableCell variant="body1" color="text.secondary" sx={{ padding: '4px 8px' }}>
                  {m.label}
                </TableCell>
                <TableCell variant="body1" sx={{ padding: '4px 8px', fontWeight: 600 }}>
                  {m.value}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid #eee' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Исследовательский результат. Не является медицинским диагнозом и не используется для решения о допуске к работе.
          </Typography>
        </Box>
      </Paper>
    </Box>
  );
};

export default ResultDetail;
