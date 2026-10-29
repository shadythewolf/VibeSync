using System;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace VibeSyncSetup
{
    /// <summary>
    /// Borderless, rounded window shared by setup and uninstall: loads its view from an embedded
    /// XAML file, handles dragging, the close button and fading between pages.
    /// </summary>
    internal abstract class ShellWindow : Window
    {
        private readonly FrameworkElement root;
        private FrameworkElement currentPage;

        /// <summary>While true the window refuses to close (an install is running).</summary>
        protected bool Busy;

        public static Application CreateApp()
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            using (var stream = Payload.Open("Styles.xaml"))
            {
                app.Resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Load(stream));
            }
            return app;
        }

        protected ShellWindow(string view, string title, Payload payload)
        {
            Title = title;
            Width = 440;
            Height = 540;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            UseLayoutRounding = true;
            Icon = payload.LoadLogo();

            using (var stream = Payload.Open(view))
            {
                root = (FrameworkElement)XamlReader.Load(stream);
            }
            Content = root;

            Find<FrameworkElement>("TitleBar").MouseLeftButtonDown += delegate { DragMove(); };
            Find<Button>("CloseButton").Click += delegate { Close(); };
            Loaded += delegate { Animate(root, 0, 1, 14); };
        }

        protected T Find<T>(string name) where T : class
        {
            var element = root.FindName(name) as T;
            if (element == null) throw new InvalidOperationException("View has no element " + name);
            return element;
        }

        protected void ShowPage(string name)
        {
            var page = Find<FrameworkElement>(name);
            if (page == currentPage) return;
            if (currentPage != null) currentPage.Visibility = Visibility.Collapsed;
            page.Visibility = Visibility.Visible;
            currentPage = page;
            Animate(page, 0, 1, 8);
            Find<Button>("CloseButton").Visibility = Busy ? Visibility.Hidden : Visibility.Visible;
        }

        protected void OnUi(Action action)
        {
            Dispatcher.BeginInvoke(action);
        }

        /// <summary>Eases the bar to a new value instead of jumping.</summary>
        protected static void SetProgress(ProgressBar bar, double value)
        {
            var animation = new DoubleAnimation(value, TimeSpan.FromMilliseconds(350))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            bar.BeginAnimation(RangeBase.ValueProperty, animation);
        }

        /// <summary>Gently breathes the logo while work is running.</summary>
        protected static void StartPulse(ScaleTransform scale)
        {
            var animation = new DoubleAnimation(1, 1.06, TimeSpan.FromMilliseconds(900))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
            };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, animation);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, animation);
        }

        protected override void OnClosing(CancelEventArgs e)
        {
            if (Busy) e.Cancel = true;
            base.OnClosing(e);
        }

        private static void Animate(FrameworkElement element, double from, double to, double rise)
        {
            var duration = TimeSpan.FromMilliseconds(260);
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            element.BeginAnimation(OpacityProperty, new DoubleAnimation(from, to, duration) { EasingFunction = ease });
            var offset = new TranslateTransform();
            element.RenderTransform = offset;
            offset.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(rise, 0, duration) { EasingFunction = ease });
        }
    }
}
